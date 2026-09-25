// 重回帰のタブ。目的変数1列を、選んだ複数の数値列で説明する最小二乗の当てはめを、
// 母集団と選択中の両方について求めて並べる。
//
// 行データは JS に取り出さない。DuckDB で「平均」と「全ペアの共分散」だけを
// 1クエリで集計し（説明変数が k 列なら (k+1)(k+2)/2 個）、係数はその行列から
// JS で解く。最小二乗の解は X'X と X'y だけで決まり、それは平均と共分散から
// 組み立てられるため、100万行でも JS 側の計算量は列数だけで決まる。
// DuckDB には重回帰の集計関数が無く、ライブラリも足さずに済む（行列は列数 ×
// 列数の小ささなので、掃き出し法で十分）。
//
// 単回帰（regression.ts）と同じく、集計クライアントはドラッグが止まってから
// 追従する Selection（settle.ts）に繋ぎ、統計量として出す値なので事前集計は
// 使わせない（filterStable: false）。タブを開いている間だけ繋ぐ（列が多いと
// 集計が重くなり、DuckDB のキューで他の集計を待たせるため）。

import { makeClient } from '@uwdata/mosaic-core';
import type { Selection, MosaicClient } from '@uwdata/mosaic-core';
import { Query, count, avg, covarPop, varPop, isNotNull, and } from '@uwdata/mosaic-sql';
import type { Coordinator } from '@uwdata/vgplot';
import { tPValue, fPValue, formatP } from './inference';
import { escapeHtml, helpTip } from './dom';
import { formatStat } from './stats';

// 説明変数の上限。初期状態でこれを超える列は外しておく。共分散の数は列数の
// 2乗で増え、表も読めなくなるため
export const MAX_PREDICTORS = 12;
// 他の列の組み合わせでほぼ表せる（完全な多重共線性）とみなす閾値。相関行列の
// コレスキー分解で、その列が他の列で説明しきれずに残る分散の割合がこれ未満なら外す
const COLLINEAR_TOLERANCE = 1e-8;
// VIF がこれを超える列には注意を出す（よく使われる目安の 10）
const VIF_WARNING = 10;

// ---------------------------------------------------------------------------
// 集計値からの当てはめ（DOM に触れない純粋な計算）
// ---------------------------------------------------------------------------

/** DuckDB から受け取る集計値。欠測のある行は除いたあと（リストワイズ除去）。 */
export interface Moments {
  n: number;
  total: number; // 欠測の除去前の行数
  means: number[]; // 説明変数 k 列 → 目的変数 の順
  cov: number[][]; // 同じ順の母共分散行列（(k+1)×(k+1)）
}

export interface Coefficient {
  column: string;
  b: number; // 係数（元の単位）
  beta: number; // 標準化係数（列を平均0・SD1に揃えたときの係数）
  se: number;
  t: number;
  p: number | null;
  vif: number;
}

export interface FitResult {
  n: number;
  dropped: number; // 欠測で除いた行数
  intercept: number;
  coefficients: Coefficient[];
  r2: number;
  adjR2: number;
  fP: number | null;
  df: number;
  // 当てはめから外した列と理由（値が一定・他の列で表せる）
  excluded: { column: string; reason: 'constant' | 'collinear' }[];
}

export type FitOutcome = { ok: true; fit: FitResult } | { ok: false; reason: string };

/**
 * 平均と共分散から最小二乗の係数・標準誤差・p 値・R² を求める。
 *
 * 列の単位の違いで数値が不安定にならないよう、共分散を相関行列に直してから解く
 * （標準化係数 β = R⁻¹ r_xy）。元の単位の係数は β に SD の比を掛けて戻す。
 * 相関行列は掃き出す前にコレスキー分解で1列ずつ確かめ、それまでの列でほぼ
 * 表せてしまう列（完全な多重共線性）は外して理由を返す。外さないと逆行列が
 * 求まらず、係数が発散する。
 */
export function fitFromMoments(columns: string[], m: Moments): FitOutcome {
  const k = columns.length;
  const excluded: FitResult['excluded'] = [];
  const sdY = Math.sqrt(m.cov[k][k]);
  if (!(sdY > 0)) return { ok: false, reason: '目的変数の値が一定のため、当てはめられません。' };

  const sd = columns.map((_, i) => Math.sqrt(m.cov[i][i]));
  const corr = (i: number, j: number) => m.cov[i][j] / (sd[i] * sd[j]);

  // 1列ずつコレスキー分解に加え、残る分散（ピボット）が小さい列を外す
  const kept: number[] = [];
  const L: number[][] = [];
  for (let j = 0; j < k; j++) {
    if (!(sd[j] > 0)) {
      excluded.push({ column: columns[j], reason: 'constant' });
      continue;
    }
    const row: number[] = [];
    for (let a = 0; a < kept.length; a++) {
      let v = corr(j, kept[a]);
      for (let b = 0; b < a; b++) v -= row[b] * L[a][b];
      row.push(v / L[a][a]);
    }
    const pivot = 1 - row.reduce((s, v) => s + v * v, 0);
    if (pivot < COLLINEAR_TOLERANCE) {
      excluded.push({ column: columns[j], reason: 'collinear' });
      continue;
    }
    row.push(Math.sqrt(pivot));
    L.push(row);
    kept.push(j);
  }

  const p = kept.length;
  const df = m.n - p - 1;
  if (p === 0) return { ok: false, reason: '使える説明変数がありません。' };
  if (df < 1) {
    return { ok: false, reason: `件数（${m.n.toLocaleString()} 件）が説明変数の数に対して少なすぎます。` };
  }

  const Rinv = invert(kept.map((i) => kept.map((j) => corr(i, j))));
  if (!Rinv) return { ok: false, reason: '説明変数どうしの相関が強すぎて、係数を求められません。' };
  const rxy = kept.map((i) => m.cov[i][k] / (sd[i] * sdY));
  const beta = Rinv.map((row) => row.reduce((s, v, j) => s + v * rxy[j], 0));
  // R² = β · r_xy。丸め誤差で 0〜1 を僅かに外れることがあるので収める
  const r2 = Math.min(1, Math.max(0, beta.reduce((s, v, j) => s + v * rxy[j], 0)));
  // 残差の分散（自由度で割った不偏推定）
  const sigma2 = (m.n * m.cov[k][k] * (1 - r2)) / df;

  const coefficients: Coefficient[] = kept.map((i, a) => {
    const b = (beta[a] * sdY) / sd[i];
    // Var(b) = σ² (X'X)⁻¹。中心化した X'X は n × 共分散なので、相関行列の逆行列を
    // SD で割り戻したものになる
    const se = Math.sqrt((sigma2 * Rinv[a][a]) / (m.n * sd[i] * sd[i]));
    const t = b / se;
    return { column: columns[i], b, beta: beta[a], se, t, p: tPValue(t, df), vif: Rinv[a][a] };
  });
  const intercept = m.means[k] - coefficients.reduce((s, c, a) => s + c.b * m.means[kept[a]], 0);
  const f = r2 < 1 ? r2 / p / ((1 - r2) / df) : Infinity;
  return {
    ok: true,
    fit: {
      n: m.n,
      dropped: m.total - m.n,
      intercept,
      coefficients,
      r2,
      adjR2: 1 - ((1 - r2) * (m.n - 1)) / df,
      fP: r2 < 1 ? fPValue(f, p, df) : 0,
      df,
      excluded,
    },
  };
}

/** 掃き出し法（部分ピボット選択つき）による逆行列。特異なら null。 */
function invert(A: number[][]): number[][] | null {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...row.map((_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let pivotRow = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[pivotRow][c])) pivotRow = r;
    if (Math.abs(M[pivotRow][c]) < 1e-12) return null;
    [M[c], M[pivotRow]] = [M[pivotRow], M[c]];
    const pv = M[c][c];
    for (let j = 0; j < 2 * n; j++) M[c][j] /= pv;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const factor = M[r][c];
      if (factor === 0) continue;
      for (let j = 0; j < 2 * n; j++) M[r][j] -= factor * M[c][j];
    }
  }
  return M.map((row) => row.slice(n));
}

// ---------------------------------------------------------------------------
// DuckDB への集計
// ---------------------------------------------------------------------------

function momentsQuery(tableName: string, columns: string[], filter: any) {
  // 列の並びは 説明変数 → 目的変数。どれか1列でも欠測の行は除く（リストワイズ除去。
  // 行ごとに使う列が違うと、共分散行列が正定値にならず係数が壊れるため）。
  // 除く前の件数（total）も同じクエリで数えたいので、WHERE ではなく集計ごとの
  // FILTER 句で除く
  const complete = and(...columns.map((c) => isNotNull(c)));
  const select: Record<string, any> = { total: count(), n: count().where(complete) };
  columns.forEach((c, i) => {
    select[`m${i}`] = avg(c).where(complete);
    for (let j = 0; j <= i; j++) {
      select[`c${i}_${j}`] = (i === j ? varPop(c) : covarPop(c, columns[j])).where(complete);
    }
  });
  return Query.from(tableName).select(select).where(filter);
}

function parseMoments(columns: string[], data: any): Moments {
  const row = data.get(0);
  const num = (v: unknown) => (v === null || v === undefined ? NaN : Number(v));
  const size = columns.length;
  const cov = Array.from({ length: size }, () => new Array<number>(size).fill(NaN));
  for (let i = 0; i < size; i++) {
    for (let j = 0; j <= i; j++) cov[i][j] = cov[j][i] = num(row[`c${i}_${j}`]);
  }
  return {
    n: Number(row.n),
    total: Number(row.total),
    means: columns.map((_, i) => num(row[`m${i}`])),
    cov,
  };
}

// ---------------------------------------------------------------------------
// 画面
// ---------------------------------------------------------------------------

export interface MultiRegressionOptions {
  db: Coordinator;
  tableName: string;
  container: HTMLElement;
  numericCols: string[];
  population: Selection; // $filter のミラー（ドラッグが止まってから追従）
  selected: Selection; // $selected のミラー（同上）
  hasSelection: () => boolean;
  brushedCols: () => Set<string>;
}

export interface MultiRegressionPanel {
  setActive(active: boolean): void;
  /**
   * 機械学習で書き戻した列（主成分得点など）を選択肢に加える。changed は値を
   * 書き換えた列で、当てはめに使っていれば集計し直す（書き戻しは同名の列を上書きする）。
   */
  setColumns(numericCols: string[], changed: string[]): void;
  /** 初期の目的変数（散布図の Y と揃える）。ユーザーが選んだ後は変えない。 */
  setDefaultTarget(column: string): void;
  /** 選択の有無・選択に使った列が変わったときの描き直し。 */
  refresh(): void;
}

export function createMultiRegressionPanel(opts: MultiRegressionOptions): MultiRegressionPanel {
  const { db, tableName, container } = opts;
  let numericCols = [...opts.numericCols];
  let target = numericCols[numericCols.length > 1 ? 1 : 0] ?? '';
  let predictors = defaultPredictors(target);
  let targetChosenByUser = false;
  let active = false;
  let clients: MosaicClient[] = [];
  let popFit: FitOutcome | null = null;
  let selFit: FitOutcome | null = null;
  let renderQueued = false;

  function defaultPredictors(y: string): string[] {
    return numericCols.filter((c) => c !== y).slice(0, MAX_PREDICTORS);
  }

  container.innerHTML = `
    <p class="ml-intro">1つの列（目的変数）を、複数の列（説明変数）の組み合わせで説明する式を求めます（重回帰）。
      ${helpTip('最小二乗法で「目的変数 = 切片 + 係数 × 説明変数 + …」を当てはめる。係数は「他の説明変数を一定にしたとき」の効き方。標準化係数 β は、列を平均0・SD1に揃えたときの係数で、単位の違う列どうしで効き方の強さを比べられる。')}</p>
    <div class="ml-controls mreg-controls"></div>
    <div class="ml-status muted"></div>
    <div class="ml-body mreg-body"></div>`;
  const controlsEl = container.querySelector<HTMLElement>('.mreg-controls')!;
  const statusEl = container.querySelector<HTMLElement>('.ml-status')!;
  const bodyEl = container.querySelector<HTMLElement>('.mreg-body')!;

  function renderControls() {
    if (numericCols.length < 2) {
      controlsEl.innerHTML = '';
      return;
    }
    const atLimit = predictors.length >= MAX_PREDICTORS;
    controlsEl.innerHTML = `
      <label>目的変数
        <select data-role="mreg-target">
          ${numericCols.map((c) => `<option value="${escapeHtml(c)}" ${c === target ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
        </select>
      </label>
      <fieldset class="column-picker"><legend>説明変数（${MAX_PREDICTORS} 列まで）</legend>${numericCols
        .filter((c) => c !== target)
        .map((c) => {
          const on = predictors.includes(c);
          return `<label class="inline-check"><input type="checkbox" data-role="mreg-x" value="${escapeHtml(c)}" ${on ? 'checked' : ''} ${
            !on && atLimit ? 'disabled' : ''
          }> ${escapeHtml(c)}</label>`;
        })
        .join('')}</fieldset>`;
    controlsEl.querySelector<HTMLSelectElement>('[data-role="mreg-target"]')!.addEventListener('change', (e) => {
      target = (e.target as HTMLSelectElement).value;
      targetChosenByUser = true;
      // 目的変数にした列は説明変数から外す。他の選択はなるべく保つ
      predictors = predictors.filter((c) => c !== target);
      if (predictors.length === 0) predictors = defaultPredictors(target);
      configChanged();
    });
    controlsEl.querySelectorAll<HTMLInputElement>('[data-role="mreg-x"]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const picked = [...controlsEl.querySelectorAll<HTMLInputElement>('[data-role="mreg-x"]:checked')].map((x) => x.value);
        if (picked.length === 0) {
          cb.checked = true; // 説明変数が0列では式にならない
          return;
        }
        predictors = picked;
        configChanged();
      });
    });
  }

  function disconnect() {
    for (const c of clients) db.disconnect(c as any);
    clients = [];
  }

  function connect() {
    disconnect();
    popFit = selFit = null;
    if (!active || numericCols.length < 2 || predictors.length === 0) {
      scheduleRender();
      return;
    }
    const columns = [...predictors, target];
    const xCols = [...predictors];
    bodyEl.classList.add('is-loading');
    const common = {
      coordinator: db,
      // 統計量として出す値なので事前集計（ピクセル単位に丸めた集計）を使わせない
      filterStable: false,
      query: (filter: any) => momentsQuery(tableName, columns, filter),
    };
    clients = [
      makeClient({
        ...common,
        selection: opts.population,
        queryResult: (data) => {
          popFit = fitFromMoments(xCols, parseMoments(columns, data));
          scheduleRender();
        },
      }),
      makeClient({
        ...common,
        selection: opts.selected,
        queryResult: (data) => {
          selFit = fitFromMoments(xCols, parseMoments(columns, data));
          scheduleRender();
        },
      }),
    ];
  }

  function configChanged() {
    renderControls();
    connect();
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  function render() {
    if (numericCols.length < 2) {
      bodyEl.classList.remove('is-loading');
      bodyEl.innerHTML = '<p class="muted">数値列が2つ以上あるときに使えます。</p>';
      statusEl.innerHTML = '';
      return;
    }
    if (!popFit) return;
    bodyEl.classList.remove('is-loading');
    const selecting = opts.hasSelection();
    const brushed = opts.brushedCols();
    const pop = popFit;
    const sel = selecting ? selFit : null;
    if (!pop.ok) {
      bodyEl.innerHTML = `<p class="muted">母集団: ${escapeHtml(pop.reason)}</p>`;
      statusEl.innerHTML = '';
      return;
    }
    const selOk = sel && sel.ok ? sel.fit : null;
    statusEl.innerHTML = `母集団 ${pop.fit.n.toLocaleString()} 行${selOk ? ` ・ 選択中 ${selOk.n.toLocaleString()} 行` : ''}で当てはめ${
      pop.fit.dropped > 0 ? `（説明変数・目的変数のどれかが欠測の行は除外: 母集団で ${pop.fit.dropped.toLocaleString()} 行）` : ''
    }`;
    bodyEl.innerHTML = `
      ${summaryHtml(pop.fit, selOk, selecting)}
      ${selecting && sel && !sel.ok ? `<p class="ml-note">選択中: ${escapeHtml(sel.reason)}</p>` : ''}
      ${tableHtml(pop.fit, selOk, brushed)}
      ${notesHtml(pop.fit, selOk, brushed)}`;
  }

  /** 文章の要約。効いている列（p < 0.05 かつ |β| ≥ 0.1）を β の大きい順に挙げる。 */
  function summaryHtml(pop: FitResult, sel: FitResult | null, selecting: boolean): string {
    const lines = [
      `母集団では、「${escapeHtml(target)}」のばらつきの <strong>${(pop.r2 * 100).toFixed(0)}%</strong> を ${pop.coefficients.length} 列で説明できます（F 検定 p ${pValueText(pop.fP)}）。${strongest(pop)}`,
    ];
    if (sel) {
      lines.push(
        `選択中では <strong>${(sel.r2 * 100).toFixed(0)}%</strong> を説明できます。${strongest(sel)}`
      );
      const changed = changedColumns(pop, sel);
      if (changed.length > 0) {
        lines.push(
          `母集団と比べて効き方が変わった列: ${changed
            .map((c) => `「${escapeHtml(c.column)}」（β ${fixed2(c.pop)} → ${fixed2(c.sel)}）`)
            .join('、')}`
        );
      }
    } else if (!selecting) {
      lines.push('<span class="muted">グラフで範囲を選ぶと、選んだ行だけで当てはめた式が並び、効き方の違いを比べられます。</span>');
    }
    return `<div class="ml-summary">${lines.map((l) => `<p>${l}</p>`).join('')}</div>`;
  }

  function strongest(fit: FitResult): string {
    const effective = fit.coefficients
      .filter((c) => c.p !== null && c.p < 0.05 && Math.abs(c.beta) >= 0.1)
      .sort((a, b) => Math.abs(b.beta) - Math.abs(a.beta));
    if (effective.length === 0) return '目立って効いている列はありません。';
    const top = effective[0];
    const rest = effective.slice(1, 3).map((c) => `「${escapeHtml(c.column)}」`);
    return `最も強く効いているのは「${escapeHtml(top.column)}」で、他の列を一定にしたまま 1 SD 増えると「${escapeHtml(target)}」は ${Math.abs(top.beta).toFixed(2)} SD ${top.beta >= 0 ? '増えます' : '減ります'}。${
      rest.length ? `次いで${rest.join('、')}が効いています。` : ''
    }`;
  }

  /**
   * 母集団と選択中で効き方が変わった列。標準化係数の差が 0.2 以上で、どちらかでは
   * 有意なもの。0.2 は効果量の「小」の目安で、係数の揺らぎだけで拾わないため。
   */
  function changedColumns(pop: FitResult, sel: FitResult) {
    const out: { column: string; pop: number; sel: number }[] = [];
    for (const pc of pop.coefficients) {
      const sc = sel.coefficients.find((c) => c.column === pc.column);
      if (!sc) continue;
      const significant = (pc.p !== null && pc.p < 0.05) || (sc.p !== null && sc.p < 0.05);
      if (significant && Math.abs(pc.beta - sc.beta) >= 0.2) out.push({ column: pc.column, pop: pc.beta, sel: sc.beta });
    }
    return out.sort((a, b) => Math.abs(b.pop - b.sel) - Math.abs(a.pop - a.sel)).slice(0, 3);
  }

  function tableHtml(pop: FitResult, sel: FitResult | null, brushed: Set<string>): string {
    const cells = (c: Coefficient | undefined) =>
      c
        ? `<td class="num">${formatStat(c.b)}</td><td>${betaBar(c.beta, c.p !== null && c.p < 0.05)}</td><td class="num">${formatP(c.p)}</td>`
        : '<td class="num muted" colspan="3">除外</td>';
    const rows = pop.coefficients
      .map((pc) => {
        const sc = sel?.coefficients.find((c) => c.column === pc.column);
        const tag = brushed.has(pc.column) ? '<span class="tag">選択に使用</span>' : '';
        const vif = pc.vif >= VIF_WARNING ? `<span class="mreg-vif-warn">${pc.vif.toFixed(1)}</span>` : pc.vif.toFixed(1);
        return `<tr><th scope="row">${escapeHtml(pc.column)}${tag}</th>${cells(pc)}${sel ? cells(sc) : ''}<td class="num">${vif}</td></tr>`;
      })
      .join('');
    const fitRow = (label: string, f: (r: FitResult) => string, first = false) =>
      `<tr class="mreg-fit ${first ? 'mreg-fit-first' : ''}"><th scope="row">${label}</th><td class="num" colspan="3">${f(pop)}</td>${sel ? `<td class="num" colspan="3">${f(sel)}</td>` : ''}<td></td></tr>`;
    return `
      <div class="table-scroll">
        <table class="ml-table mreg-table">
          <thead>
            <tr><th rowspan="2">説明変数</th><th colspan="3">母集団</th>${sel ? '<th colspan="3" class="mreg-sel-head">選択中</th>' : ''}<th rowspan="2">VIF${helpTip('分散拡大係数。その列が他の説明変数とどれだけ重なっているか。10 を超えると係数が不安定で、解釈に注意が要る。母集団での値。')}</th></tr>
            <tr>${'<th>係数</th><th>β</th><th>p</th>'.repeat(sel ? 2 : 1)}</tr>
          </thead>
          <tbody>
            ${rows}
            ${fitRow('切片', (r) => formatStat(r.intercept), true)}
            ${fitRow('R²（調整済み）', (r) => `${r.r2.toFixed(3)}（${r.adjR2.toFixed(3)}）`)}
            ${fitRow('n', (r) => r.n.toLocaleString())}
          </tbody>
        </table>
      </div>`;
  }

  function notesHtml(pop: FitResult, sel: FitResult | null, brushed: Set<string>): string {
    const notes: string[] = [];
    const excluded = [...pop.excluded, ...(sel?.excluded ?? []).filter((e) => !pop.excluded.some((p) => p.column === e.column))];
    if (excluded.length > 0) {
      notes.push(
        `当てはめから外した列: ${excluded
          .map((e) => `${escapeHtml(e.column)}（${e.reason === 'constant' ? '値が一定' : '他の説明変数の組み合わせで表せる'}）`)
          .join('、')}`
      );
    }
    if (pop.coefficients.some((c) => c.vif >= VIF_WARNING)) {
      notes.push(`VIF が ${VIF_WARNING} を超える列は、他の説明変数と重なりが大きく、係数の大きさや符号が不安定です。どちらかを外すと解釈しやすくなります。`);
    }
    if (sel && brushed.has(target)) {
      notes.push(`目的変数「${escapeHtml(target)}」の範囲で選んでいるため、選択中の係数は小さく出る方向に偏ります（範囲を切り取ると、説明変数との関係が弱く見える）。`);
    }
    notes.push('β の棒が薄い列は p ≥ 0.05（偶然の範囲）。係数は「他の説明変数を一定にしたとき」の効き方で、因果関係を示すものではありません。');
    return notes.map((n) => `<p class="ml-note">${n}</p>`).join('');
  }

  renderControls();
  render();

  return {
    setActive(on: boolean) {
      if (on === active) return;
      active = on;
      if (active) connect();
      else disconnect();
    },
    setColumns(cols: string[], changed: string[]) {
      numericCols = [...cols];
      renderControls();
      if (active && changed.some((c) => c === target || predictors.includes(c))) connect();
    },
    setDefaultTarget(column: string) {
      if (targetChosenByUser || !numericCols.includes(column) || column === target) return;
      target = column;
      predictors = defaultPredictors(target);
      configChanged();
    },
    refresh() {
      if (active) scheduleRender();
    },
  };
}

/**
 * 標準化係数を、0 を中心に左右へ伸びる棒と数値で示す。統計量タブの効果量 d と
 * 同じ部品（.effect-*）を使い、有意でない係数は薄く描く。
 */
function betaBar(beta: number, significant: boolean): string {
  const w = Math.min(1, Math.abs(beta)) * 50;
  const pos = beta >= 0 ? `left:50%;width:${w}%` : `left:${50 - w}%;width:${w}%`;
  return `<span class="effect"><span class="effect-track"><span class="effect-bar ${beta >= 0 ? 'pos' : 'neg'} ${
    significant ? '' : 'weak'
  }" style="${pos}"></span></span><span class="effect-value">${fixed2(beta)}</span></span>`;
}

/** 小数2桁。丸めると 0 になる負の値を「-0.00」と出さない。 */
function fixed2(v: number): string {
  return (Math.abs(v) < 0.005 ? 0 : v).toFixed(2);
}

function pValueText(p: number | null): string {
  return p !== null && p < 0.001 ? formatP(p) : `= ${formatP(p)}`;
}
