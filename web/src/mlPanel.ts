// 機械学習タブ（クラスタ・主成分・変数重要度）の画面と、DuckDB との橋渡し。
//
// 流れ: 分析範囲（選択中、選択が無ければ母集団）の行を DuckDB から数千行だけ
// 取り出す → Web Worker で計算（ml.ts）→ 結果を文章と表で表示する。
//
// k-means と PCA の結果は「列としてテーブルに書き戻す」ことができる。書き戻した
// 列は散布図の色分け・軸に選べるので、クラスタや主成分得点の上でも
// そのままクロスフィルタが効く。別のチャートを新設せず、既存の連動の中に
// 機械学習の結果を流し込む設計にした（CLAUDE.md「チャートの種類を増やす
// より連動の完成度」）。

import type { Coordinator } from '@uwdata/vgplot';
import type { MLRequest, MLResponse } from './ml-protocol';
import type { Matrix } from './ml';
import { quoteIdent } from './sql';
import { escapeHtml, helpTip, toast } from './dom';
import { formatStat } from './stats';
import { PALETTE } from './categories';

// Worker に渡す行数の上限。k-means・PCA は数千行あれば構造は十分に見え、
// ランダムフォレストは行数に対して n log n で重くなるため。
const MAX_ROWS = 4000;
// 変数重要度の学習に使う、選択中・選択外それぞれの最大行数
const MAX_ROWS_PER_CLASS = 2000;
// 欠測がこれを超える列は機械学習の入力から外す。欠測のある行は丸ごと
// 除くしかないので、欠測の多い列を入れると使える行が激減するため
const MAX_MISSING_RATE = 0.3;
const MIN_ROWS = 10;
// 欠測があって距離を測れず、クラスタを割り当てられない行の表示名。
// NULL のままだと色分けの凡例に「null」と出て、何のことか分からないため
const UNASSIGNED = '（欠測あり）';

export interface AnalysisScope {
  selectedSql: string; // 選択中の行を表す WHERE 条件（フィルタ条件も含む）
  populationSql: string; // 母集団（フィルタ後）の WHERE 条件
  hasSelection: boolean;
  selectedCount: number;
  populationCount: number;
  brushedCols: Set<string>; // チャートの範囲選択に使われている列
}

export interface AddedColumns {
  numeric: string[];
  categorical: string[];
  axes?: [string, string];
  color?: string;
}

// ---------------------------------------------------------------------------
// Worker との通信
// ---------------------------------------------------------------------------

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (res: MLResponse) => void>();

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

function runInWorker(req: DistributiveOmit<MLRequest, 'id'>): Promise<MLResponse> {
  if (!worker) {
    worker = new Worker(new URL('./ml.worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (e: MessageEvent<MLResponse>) => {
      pending.get(e.data.id)?.(e.data);
      pending.delete(e.data.id);
    });
  }
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker!.postMessage({ ...req, id } as MLRequest);
  });
}

// ---------------------------------------------------------------------------
// DuckDB からの行の取り出し
// ---------------------------------------------------------------------------

interface FeatureSelection {
  used: string[];
  excludedMissing: string[];
  excludedConstant: string[];
}

/**
 * 機械学習に使う列を決める。欠測が多すぎる列・分析範囲内で値が一定の列を外す
 * （一定の列は標準化できず、情報も持たないため）。1クエリでまとめて調べる。
 */
async function chooseFeatures(
  db: Coordinator,
  tableName: string,
  candidates: string[],
  where: string
): Promise<FeatureSelection> {
  if (candidates.length === 0) return { used: [], excludedMissing: [], excludedConstant: [] };
  const selects = candidates
    .map((c, i) => `count(${quoteIdent(c)}) AS n${i}, stddev(${quoteIdent(c)}) AS s${i}`)
    .join(', ');
  const row: any = (
    await db.query(`SELECT count(*) AS total, ${selects} FROM ${quoteIdent(tableName)} WHERE ${where}`, {
      cache: false,
    })
  ).get(0);
  const total = Number(row.total);
  const result: FeatureSelection = { used: [], excludedMissing: [], excludedConstant: [] };
  candidates.forEach((c, i) => {
    const n = Number(row[`n${i}`]);
    const sd = Number(row[`s${i}`]);
    if (total === 0 || 1 - n / total > MAX_MISSING_RATE) result.excludedMissing.push(c);
    else if (!(sd > 0)) result.excludedConstant.push(c);
    else result.used.push(c);
  });
  return result;
}

/**
 * 指定条件の行から、使う列がすべて埋まっている行を最大 limit 行取り出す。
 * 間引きは ORDER BY hash(rowid) で行う。乱数ではなくハッシュ順にするのは、
 * 同じ選択なら毎回同じ行が選ばれ、結果が再現するようにするため。
 */
async function fetchMatrix(
  db: Coordinator,
  tableName: string,
  cols: string[],
  where: string,
  limit: number
): Promise<{ X: Matrix; incomplete: number }> {
  const notNull = cols.map((c) => `${quoteIdent(c)} IS NOT NULL`).join(' AND ');
  const select = cols.map((c, i) => `CAST(${quoteIdent(c)} AS DOUBLE) AS v${i}`).join(', ');
  const table = quoteIdent(tableName);
  const [rowsRes, countRes]: any[] = await Promise.all([
    db.query(`SELECT ${select} FROM ${table} WHERE (${where}) AND ${notNull} ORDER BY hash(rowid) LIMIT ${limit}`, {
      cache: false,
    }),
    db.query(`SELECT count(*) FILTER (WHERE NOT (${notNull})) AS incomplete FROM ${table} WHERE ${where}`, {
      cache: false,
    }),
  ]);
  const X: Matrix = rowsRes.toArray().map((r: any) => cols.map((_, i) => Number(r[`v${i}`])));
  return { X, incomplete: Number(countRes.get(0).incomplete) };
}

// 選択外 = 母集団のうち選択中でない行。選択条件が NULL（欠測で判定不能）に
// なる行も「選択されていない」側に入れるため、NOT の前に COALESCE する
function restSql(scope: AnalysisScope): string {
  return `(${scope.populationSql}) AND NOT COALESCE((${scope.selectedSql}), FALSE)`;
}

function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

function zExpr(col: string, mean: number, sd: number): string {
  return `((CAST(${quoteIdent(col)} AS DOUBLE) - ${mean}) / ${sd})`;
}

// ---------------------------------------------------------------------------
// 表示の部品
// ---------------------------------------------------------------------------

/** 標準化した値（z）を青〜橙の背景色にする。0 付近は無色、±2 で最も濃い。 */
function zColor(z: number): string {
  const a = Math.min(Math.abs(z) / 2, 1) * 0.55;
  return z >= 0 ? `rgba(37, 99, 235, ${a})` : `rgba(217, 72, 15, ${a})`;
}

function scopeText(scope: AnalysisScope): string {
  return scope.hasSelection
    ? `選択中の <strong>${scope.selectedCount.toLocaleString()}</strong> 件`
    : `母集団の <strong>${scope.populationCount.toLocaleString()}</strong> 件（チャートで範囲を選ぶと、選んだ行だけで分析します）`;
}

function exclusionNote(features: FeatureSelection, incomplete: number): string {
  const notes: string[] = [];
  if (features.excludedMissing.length > 0) {
    notes.push(`欠測が ${MAX_MISSING_RATE * 100}% を超える列を除外: ${features.excludedMissing.map(escapeHtml).join('、')}`);
  }
  if (features.excludedConstant.length > 0) {
    notes.push(`値が一定の列を除外: ${features.excludedConstant.map(escapeHtml).join('、')}`);
  }
  if (incomplete > 0) notes.push(`欠測を含む ${incomplete.toLocaleString()} 行は除外`);
  return notes.length > 0 ? `<p class="ml-note">${notes.join(' / ')}</p>` : '';
}

function loading(container: HTMLElement, message: string) {
  const existing = container.querySelector('.ml-body');
  if (existing) existing.classList.add('is-loading');
  const status = container.querySelector('.ml-status');
  if (status) status.textContent = message;
}

// ---------------------------------------------------------------------------
// パネル本体
// ---------------------------------------------------------------------------

export type MLTab = 'cluster' | 'pca' | 'importance';

export interface MLPanelOptions {
  db: Coordinator;
  tableName: string;
  numericCols: string[];
  existingCols: string[];
  containers: Record<MLTab, HTMLElement>;
  getScope: () => AnalysisScope;
  onColumnsAdded: (added: AddedColumns) => Promise<void>;
}

export interface MLPanel {
  setActive(tab: MLTab | null): void;
  scopeChanged(): void;
}

export function createMLPanel(opts: MLPanelOptions): MLPanel {
  const { db, tableName, numericCols, containers } = opts;
  const takenNames = new Set(opts.existingCols);
  let active: MLTab | null = null;
  let timer: number | undefined;
  // 同じ条件で計算し直さないための、前回実行時の条件
  const lastKey: Record<MLTab, string> = { cluster: '', pca: '', importance: '' };
  // 計算中に選択が変わったとき、古い結果で上書きしないための世代番号
  const generation: Record<MLTab, number> = { cluster: 0, pca: 0, importance: 0 };

  // 書き戻しボタン用に、最後の計算結果を覚えておく
  let lastCluster: { labels: string[]; order: number[]; centroids: Matrix; means: number[]; sds: number[]; cols: string[] } | null = null;
  let lastPca: { loadings: Matrix; means: number[]; sds: number[]; cols: string[] } | null = null;

  let clusterK: number | null = null; // null = 自動
  let includeBrushed = false;

  function shell(tab: MLTab, intro: string, controls = '') {
    containers[tab].innerHTML = `
      <p class="ml-intro">${intro}</p>
      ${controls ? `<div class="ml-controls">${controls}</div>` : ''}
      <div class="ml-status muted"></div>
      <div class="ml-body"></div>`;
  }

  shell(
    'cluster',
    `似た行どうしを自動でグループに分けます（k-means 法）。${helpTip('列ごとに平均0・SD1に揃えてから、互いの距離が近い行をまとめる。クラスタ数は「自動」ならシルエット係数（分かれ具合の指標）が最大になる数を選ぶ。')}`,
    `<label>クラスタ数
       <select class="ml-k">
         <option value="">自動（おすすめ）</option>
         ${[2, 3, 4, 5, 6].map((k) => `<option value="${k}">${k}</option>`).join('')}
       </select>
     </label>
     <button type="button" class="primary-button ml-apply" disabled>クラスタで散布図を色分け</button>`
  );
  shell(
    'pca',
    `たくさんの列を、情報をなるべく失わずに少数の軸（主成分）にまとめます（PCA）。${helpTip('列ごとに平均0・SD1に揃えた上で、ばらつきが最も大きい方向から順に軸を取る。寄与率はその軸が全体のばらつきの何割を説明するか。')}`,
    `<button type="button" class="primary-button ml-apply" disabled>主成分1・2 を散布図の軸にする</button>`
  );
  shell(
    'importance',
    `選んだ行を、それ以外の行と見分けるのに役立っている列を順位付けします（ランダムフォレスト）。${helpTip('選択中/選択外を当てる決定木を60本学習し、各列が分類にどれだけ貢献したか（Gini 重要度）を合計1で示す。精度は学習に使わなかった行で測った、両群の正解率の平均。')}`,
    `<label class="inline-check"><input type="checkbox" class="ml-include-brushed"> 選択に使った列も含める</label>`
  );

  containers.cluster.querySelector<HTMLSelectElement>('.ml-k')!.addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    clusterK = v === '' ? null : Number(v);
    run('cluster');
  });
  containers.importance.querySelector<HTMLInputElement>('.ml-include-brushed')!.addEventListener('change', (e) => {
    includeBrushed = (e.target as HTMLInputElement).checked;
    run('importance');
  });

  // ---- クラスタ ----
  async function runCluster(scope: AnalysisScope, gen: number) {
    const el = containers.cluster;
    const where = scope.hasSelection ? scope.selectedSql : scope.populationSql;
    const features = await chooseFeatures(db, tableName, numericCols, where);
    if (features.used.length < 2) {
      finish(el, `<p class="muted">使える数値列が2つ未満のため、クラスタ分析できません。</p>`, `対象: ${scopeText(scope)}`);
      return;
    }
    const { X, incomplete } = await fetchMatrix(db, tableName, features.used, where, MAX_ROWS);
    if (X.length < MIN_ROWS) {
      finish(el, `<p class="muted">欠測のない行が ${X.length} 件しかなく、分析できません。</p>`, `対象: ${scopeText(scope)}`);
      return;
    }
    const res = await runInWorker({ type: 'kmeans', X, k: clusterK });
    if (gen !== generation.cluster) return;
    if (res.type !== 'kmeans') throw new Error(res.type === 'error' ? res.message : '想定外の応答');

    // クラスタ番号を大きい順に振り直す（「クラスタ1」が常に最大のまとまりになるように）
    const sizes = new Array(res.k).fill(0);
    res.labels.forEach((l) => sizes[l]++);
    const order = sizes.map((_, i) => i).sort((a, b) => sizes[b] - sizes[a]);
    const names = order.map((_, rank) => `クラスタ${rank + 1}`);
    lastCluster = { labels: names, order, centroids: res.centroids, means: res.means, sds: res.sds, cols: features.used };

    const sil = res.scores?.find((s) => s.k === res.k)?.silhouette;
    const silWord = sil === undefined ? '' : sil >= 0.5 ? 'はっきり分かれている' : sil >= 0.25 ? 'まずまず分かれている' : '境目があいまい';

    const rows = order
      .map((c, rank) => {
        const centroid = res.centroids[c];
        // 各クラスタの特徴を、平均からのずれが大きい列の上位2つで言葉にする
        const traits = centroid
          .map((z, j) => ({ z, col: features.used[j] }))
          .filter((t) => Math.abs(t.z) >= 0.5)
          .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
          .slice(0, 2)
          .map((t) => `${escapeHtml(t.col)} が${t.z > 0 ? '高い' : '低い'}`)
          .join('・');
        const cells = centroid
          .map((z, j) => {
            const value = res.means[j] + z * res.sds[j];
            return `<td style="background:${zColor(z)}" title="標準化した値 ${z >= 0 ? '+' : ''}${z.toFixed(2)}">${formatStat(value)}</td>`;
          })
          .join('');
        const share = (sizes[c] / X.length) * 100;
        return `<tr>
          <th scope="row"><span class="swatch" style="background:${PALETTE[rank % PALETTE.length]}"></span>${names[rank]}</th>
          <td class="num">${sizes[c].toLocaleString()}<small class="muted">（${share.toFixed(0)}%）</small></td>
          <td class="trait">${traits || '<span class="muted">平均的</span>'}</td>
          ${cells}
        </tr>`;
      })
      .join('');

    const scoreBars = res.scores
      ? `<div class="k-scores" title="クラスタ数ごとのシルエット係数（大きいほどよく分かれている）">
           ${res.scores
             .map(
               (s) =>
                 `<div class="k-score ${s.k === res.k ? 'chosen' : ''}"><div class="k-bar" style="height:${Math.max(4, s.silhouette * 100)}%"></div><span>${s.k}</span></div>`
             )
             .join('')}
         </div>`
      : '';

    finish(
      el,
      `
      <div class="ml-summary">
        ${scoreBars}
        <p><strong>${res.k} つのクラスタ</strong>に分かれました${sil !== undefined ? `（シルエット係数 ${sil.toFixed(2)}：${silWord}）` : ''}。
        色は各列の平均との比較で、<span class="chip-pos">青 = 高い</span>・<span class="chip-neg">橙 = 低い</span>。</p>
      </div>
      <div class="table-scroll">
        <table class="ml-table">
          <thead><tr><th>クラスタ</th><th>件数</th><th class="left">特徴</th>${features.used.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${exclusionNote(features, incomplete)}`,
      `対象: ${scopeText(scope)}（最大 ${MAX_ROWS.toLocaleString()} 行を使用）`
    );
    el.querySelector<HTMLButtonElement>('.ml-apply')!.disabled = false;
  }

  // ---- 主成分 ----
  async function runPca(scope: AnalysisScope, gen: number) {
    const el = containers.pca;
    const where = scope.hasSelection ? scope.selectedSql : scope.populationSql;
    const features = await chooseFeatures(db, tableName, numericCols, where);
    if (features.used.length < 2) {
      finish(el, `<p class="muted">使える数値列が2つ未満のため、主成分分析できません。</p>`, `対象: ${scopeText(scope)}`);
      return;
    }
    const { X, incomplete } = await fetchMatrix(db, tableName, features.used, where, MAX_ROWS);
    if (X.length < MIN_ROWS) {
      finish(el, `<p class="muted">欠測のない行が ${X.length} 件しかなく、分析できません。</p>`, `対象: ${scopeText(scope)}`);
      return;
    }
    const res = await runInWorker({ type: 'pca', X });
    if (gen !== generation.pca) return;
    if (res.type !== 'pca') throw new Error(res.type === 'error' ? res.message : '想定外の応答');
    lastPca = { loadings: res.loadings, means: res.means, sds: res.sds, cols: features.used };

    const shown = Math.min(res.explained.length, 6);
    let cumulative = 0;
    const scree = res.explained
      .slice(0, shown)
      .map((e, i) => {
        cumulative += e;
        return `<div class="scree-row">
          <span class="scree-label">主成分${i + 1}</span>
          <div class="scree-track"><div class="scree-bar" style="width:${e * 100}%"></div></div>
          <span class="scree-value">${(e * 100).toFixed(1)}%<small class="muted">（累積 ${(cumulative * 100).toFixed(0)}%）</small></span>
        </div>`;
      })
      .join('');

    const describePc = (i: number) => {
      const vec = res.loadings[i];
      const strong = vec
        .map((w, j) => ({ w, col: features.used[j] }))
        .filter((t) => Math.abs(t.w) >= 0.3)
        .sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
      const up = strong.filter((t) => t.w > 0).map((t) => escapeHtml(t.col));
      const down = strong.filter((t) => t.w < 0).map((t) => escapeHtml(t.col));
      const parts = [up.length ? `${up.join('・')} が大きい` : '', down.length ? `${down.join('・')} が小さい` : '']
        .filter(Boolean)
        .join('、');
      return `<li><strong>主成分${i + 1}</strong>（${(res.explained[i] * 100).toFixed(0)}%）: ${parts || '特定の列に偏らない'}ほど大きくなる軸</li>`;
    };

    const pcsInTable = Math.min(3, res.loadings.length);
    const loadingRows = features.used
      .map(
        (c, j) =>
          `<tr><th scope="row">${escapeHtml(c)}</th>${Array.from({ length: pcsInTable }, (_, i) => {
            const w = res.loadings[i][j];
            return `<td style="background:${zColor(w * 2.5)}">${w >= 0 ? '+' : ''}${w.toFixed(2)}</td>`;
          }).join('')}</tr>`
      )
      .join('');

    finish(
      el,
      `
      <div class="pca-grid">
        <div>
          <h3>寄与率${helpTip('その主成分が、全体のばらつきの何割を説明しているか。上位の主成分だけで累積が大きければ、少ない軸でデータの大半を表せる。')}</h3>
          ${scree}
        </div>
        <div>
          <h3>各主成分の意味</h3>
          <ul class="pc-list">${describePc(0)}${res.loadings.length > 1 ? describePc(1) : ''}</ul>
          <div class="table-scroll">
            <table class="ml-table">
              <thead><tr><th>列</th>${Array.from({ length: pcsInTable }, (_, i) => `<th>主成分${i + 1}</th>`).join('')}</tr></thead>
              <tbody>${loadingRows}</tbody>
            </table>
          </div>
        </div>
      </div>
      ${exclusionNote(features, incomplete)}`,
      `対象: ${scopeText(scope)}（最大 ${MAX_ROWS.toLocaleString()} 行を使用）`
    );
    el.querySelector<HTMLButtonElement>('.ml-apply')!.disabled = false;
  }

  // ---- 変数重要度 ----
  async function runImportance(scope: AnalysisScope, gen: number) {
    const el = containers.importance;
    if (!scope.hasSelection) {
      finish(
        el,
        `<div class="ml-empty">チャート上をドラッグして範囲を選ぶと、<br>選んだ行を他と見分けるのに効いている列がここに並びます。</div>`,
        ''
      );
      return;
    }
    const candidates = includeBrushed ? numericCols : numericCols.filter((c) => !scope.brushedCols.has(c));
    const features = await chooseFeatures(db, tableName, candidates, scope.populationSql);
    if (features.used.length < 1) {
      finish(
        el,
        `<p class="muted">使える数値列がありません。${scope.brushedCols.size > 0 ? '「選択に使った列も含める」をオンにすると計算できます。' : ''}</p>`,
        ''
      );
      return;
    }
    const [sel, rest] = await Promise.all([
      fetchMatrix(db, tableName, features.used, scope.selectedSql, MAX_ROWS_PER_CLASS),
      fetchMatrix(db, tableName, features.used, restSql(scope), MAX_ROWS_PER_CLASS),
    ]);
    if (sel.X.length < MIN_ROWS || rest.X.length < MIN_ROWS) {
      finish(el, `<p class="muted">選択中か選択外の行が少なすぎて（${MIN_ROWS} 行未満）学習できません。</p>`, '');
      return;
    }
    const X = [...sel.X, ...rest.X];
    const y = [...sel.X.map(() => 1), ...rest.X.map(() => 0)];
    const res = await runInWorker({ type: 'importance', X, y });
    if (gen !== generation.importance) return;
    if (res.type !== 'importance') throw new Error(res.type === 'error' ? res.message : '想定外の応答');

    const ranked = res.importance
      .map((v, j) => ({ v, col: features.used[j] }))
      .sort((a, b) => b.v - a.v);
    const max = ranked[0]?.v || 1;
    const bars = ranked
      .map(
        (r, i) => `<div class="imp-row">
          <span class="imp-rank">${i + 1}</span>
          <span class="imp-label">${escapeHtml(r.col)}</span>
          <div class="imp-track"><div class="imp-bar" style="width:${(r.v / max) * 100}%"></div></div>
          <span class="imp-value">${(r.v * 100).toFixed(1)}%</span>
        </div>`
      )
      .join('');

    const acc = res.oobBalancedAccuracy;
    const accText =
      acc === null
        ? ''
        : acc >= 0.8
          ? `これらの列で、選択中と選択外を <strong>${(acc * 100).toFixed(0)}%</strong> の精度で見分けられます。上位の列が、選んだ行の特徴をよく表しています。`
          : acc >= 0.65
            ? `見分けられる精度は <strong>${(acc * 100).toFixed(0)}%</strong> で、ある程度の手がかりはあります。`
            : `見分けられる精度は <strong>${(acc * 100).toFixed(0)}%</strong>（当てずっぽうは 50%）で、選んだ行はこれらの列ではほとんど区別できません。`;
    const brushedNote =
      !includeBrushed && scope.brushedCols.size > 0
        ? `<p class="ml-note">選択に使った列（${[...scope.brushedCols].map(escapeHtml).join('、')}）は除外しています。その列で選んだのだから、効くのは当然なためです。</p>`
        : '';

    finish(
      el,
      `<p class="ml-summary-text">${accText}</p>
       <div class="imp-list">${bars}</div>
       ${brushedNote}
       ${exclusionNote(features, sel.incomplete + rest.incomplete)}`,
      `選択中 ${sel.X.length.toLocaleString()} 行 と 選択外 ${rest.X.length.toLocaleString()} 行で学習`
    );
  }

  function finish(el: HTMLElement, bodyHtml: string, statusHtml: string) {
    const body = el.querySelector('.ml-body')!;
    body.innerHTML = bodyHtml;
    body.classList.remove('is-loading');
    el.querySelector('.ml-status')!.innerHTML = statusHtml;
  }

  const runners: Record<MLTab, (scope: AnalysisScope, gen: number) => Promise<void>> = {
    cluster: runCluster,
    pca: runPca,
    importance: runImportance,
  };

  function keyFor(tab: MLTab, scope: AnalysisScope): string {
    const base = `${scope.selectedSql}|${scope.populationSql}|${scope.hasSelection}`;
    if (tab === 'cluster') return `${base}|${clusterK}`;
    if (tab === 'importance') return `${base}|${includeBrushed}|${[...scope.brushedCols].join(',')}`;
    return base;
  }

  async function run(tab: MLTab) {
    const scope = opts.getScope();
    const key = keyFor(tab, scope);
    if (key === lastKey[tab]) return;
    lastKey[tab] = key;
    const gen = ++generation[tab];
    loading(containers[tab], '計算中…');
    const apply = containers[tab].querySelector<HTMLButtonElement>('.ml-apply');
    if (apply) apply.disabled = true;
    try {
      await runners[tab](scope, gen);
    } catch (e) {
      if (gen !== generation[tab]) return;
      lastKey[tab] = '';
      finish(containers[tab], `<p class="error">⚠️ 計算に失敗しました: ${escapeHtml(e instanceof Error ? e.message : String(e))}</p>`, '');
    }
  }

  // ---- 列として書き戻す ----

  /**
   * k-means の結果を「クラスタ」列として書き戻す。分析範囲で学習した中心に
   * 対し、全行を最も近い中心に割り当てる（使った列に欠測がある行は
   * UNASSIGNED）（範囲外の行にも付けることで、
   * 色分けしたときに「選んだ範囲で見つけたグループが全体ではどこにいるか」
   * まで見えるようにする）。距離計算は SQL で行い、行データを JS に戻さない。
   */
  async function applyClusters() {
    if (!lastCluster) return;
    const { labels, order, centroids, means, sds, cols } = lastCluster;
    const name = uniqueName('クラスタ', takenNames);
    const anyNull = cols.map((c) => `${quoteIdent(c)} IS NULL`).join(' OR ');
    const dists = order.map((c) =>
      cols.map((col, j) => `power(${zExpr(col, means[j], sds[j])} - (${centroids[c][j]}), 2)`).join(' + ')
    );
    const labelList = `[${labels.map((l) => `'${l}'`).join(', ')}]`;
    const distList = `[${dists.map((d) => `(${d})`).join(', ')}]`;
    const table = quoteIdent(tableName);
    await db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${quoteIdent(name)} VARCHAR`);
    await db.exec(
      `UPDATE ${table} SET ${quoteIdent(name)} = CASE WHEN ${anyNull} THEN '${UNASSIGNED}' ELSE ${labelList}[list_position(${distList}, list_min(${distList}))] END`
    );
    takenNames.add(name);
    await opts.onColumnsAdded({ numeric: [], categorical: [name], color: name });
    toast(`「${name}」列を追加し、散布図をクラスタで色分けしました`);
  }

  /** 主成分1・2の得点を列として書き戻し、散布図の軸にする。 */
  async function applyPca() {
    if (!lastPca) return;
    const { loadings, means, sds, cols } = lastPca;
    const names = [uniqueName('主成分1', takenNames), uniqueName('主成分2', takenNames)];
    const table = quoteIdent(tableName);
    for (let i = 0; i < 2; i++) {
      const expr = cols.map((col, j) => `(${loadings[i][j]}) * ${zExpr(col, means[j], sds[j])}`).join(' + ');
      await db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${quoteIdent(names[i])} DOUBLE`);
      await db.exec(`UPDATE ${table} SET ${quoteIdent(names[i])} = ${expr}`);
      takenNames.add(names[i]);
    }
    await opts.onColumnsAdded({ numeric: names, categorical: [], axes: [names[0], names[1]] });
    toast(`「${names[0]}」「${names[1]}」列を追加し、散布図の軸にしました`);
  }

  for (const [tab, fn] of [
    ['cluster', applyClusters],
    ['pca', applyPca],
  ] as const) {
    const button = containers[tab].querySelector<HTMLButtonElement>('.ml-apply')!;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await fn();
      } catch (e) {
        toast(`⚠️ 列の追加に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        button.disabled = false;
      }
    });
  }

  return {
    setActive(tab) {
      active = tab;
      if (tab) run(tab);
    },
    scopeChanged() {
      // ドラッグ中は選択が連続して変わるので、止まってから計算する
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (active) run(active);
      }, 450);
    },
  };
}
