// 件数・要約統計量・群間比較（CLAUDE.md「次にやること」3・4）。
//
// 選択中（$brush）と母集団（$filter）それぞれに Mosaic クライアントを1つずつ
// 繋ぎ、フィルタやドラッグのたびに SQL 集計を DuckDB に投げ直す。
// 集計はすべて DuckDB 側で行い、JS 側へは1行の結果だけを持ってくる
// （行データを JS に取り出すと 100万行規模で破綻するため）。
//
// 群間比較は「選択中 vs 選択外（母集団の残り）」の2群で行う。クロスフィルタで
// 範囲を選ぶ行為そのものが「この群は他と何が違うか」という問いなので、
// 比較の相手は母集団全体ではなく残りの行にする（母集団全体と比べると、
// 選択中が両方の群に含まれてしまい検定として成り立たない）。
//
// 欠測件数は Python版と同様に常に見える形にする。測定漏れがあるデータが
// 前提であり、平均などの値が「何件の値から計算されたか」を並べて示さないと
// 選択範囲の比較を誤読しやすいため。

import { makeClient } from '@uwdata/mosaic-core';
import type { Selection } from '@uwdata/mosaic-core';
import { Query, count, avg, variance, min, max, median } from '@uwdata/mosaic-sql';
import type { Coordinator } from '@uwdata/vgplot';
import { welchTTest, subtractGroup, formatP, effectLabel } from './inference';
import type { WelchResult } from './inference';
import { escapeHtml, helpTip } from './dom';

export interface ColumnStats {
  n: number; // 非欠測の件数
  missing: number;
  mean: number | null;
  variance: number | null; // 不偏分散。群間比較（選択外の分散の逆算）に使う
  min: number | null;
  median: number | null;
  max: number | null;
}

export interface StatsSnapshot {
  rows: number;
  columns: ColumnStats[];
}

function toNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v); // BIGINT 列の min/max は BigInt で返るため Number に揃える
  return Number.isFinite(n) ? n : null;
}

/**
 * 全数値列の統計量を1クエリで取る。列ごとにクエリを分けると、ドラッグの
 * たびに列数分のテーブルスキャンが走るため。別名は列名ではなく連番にする
 * （列名に記号や重複しうる文字が入っても別名の衝突を気にしなくて済むように）。
 */
function statsQuery(tableName: string, cols: string[], filter: any) {
  const select: Record<string, any> = { __rows: count() };
  cols.forEach((c, i) => {
    select[`n${i}`] = count(c);
    select[`mean${i}`] = avg(c);
    select[`var${i}`] = variance(c);
    select[`min${i}`] = min(c);
    select[`med${i}`] = median(c);
    select[`max${i}`] = max(c);
  });
  return Query.from(tableName).select(select).where(filter);
}

function parseStats(cols: string[], data: any): StatsSnapshot {
  const row = data.get(0);
  const rows = Number(row.__rows);
  return {
    rows,
    columns: cols.map((_, i) => {
      const n = Number(row[`n${i}`]);
      return {
        n,
        missing: rows - n,
        mean: toNumberOrNull(row[`mean${i}`]),
        variance: toNumberOrNull(row[`var${i}`]),
        min: toNumberOrNull(row[`min${i}`]),
        median: toNumberOrNull(row[`med${i}`]),
        max: toNumberOrNull(row[`max${i}`]),
      };
    }),
  };
}

/**
 * 選択中・母集団の2系統に集計クライアントを繋ぐ。
 *
 * 件数は統計量クエリの count(*) から取る（件数専用のクライアントを別に
 * 繋ぐとスキャンが倍になるため）。数値列が無いデータでも件数は必要なので、
 * その場合も count(*) だけのクエリとして同じ経路を通す。
 *
 * db.clear() で切断される前提なので、呼び出し側はチャートを作り直すたびに
 * これも呼び直す。
 */
export function connectStatsClients(
  db: Coordinator,
  tableName: string,
  numericCols: string[],
  $filter: Selection,
  $selected: Selection,
  onUpdate: (selected: StatsSnapshot | null, population: StatsSnapshot | null) => void
) {
  let selected: StatsSnapshot | null = null;
  let population: StatsSnapshot | null = null;

  makeClient({
    coordinator: db,
    // 事前集計（preaggregation）を使わせない。Mosaic の事前集計はブラシの
    // 範囲を画面のピクセル単位に丸めて集計するため、描画には十分でも
    // 件数や平均が厳密な値から1件単位でずれる（統計量として出す値には不適）
    filterStable: false,
    selection: $filter,
    query: (filter) => statsQuery(tableName, numericCols, filter),
    queryResult: (data) => {
      population = parseStats(numericCols, data);
      onUpdate(selected, population);
    },
  });
  makeClient({
    coordinator: db,
    filterStable: false, // 上と同じ理由で事前集計を使わせない
    selection: $selected,
    query: (filter) => statsQuery(tableName, numericCols, filter),
    queryResult: (data) => {
      selected = parseStats(numericCols, data);
      onUpdate(selected, population);
    },
  });
}

/**
 * 選択件数だけを数える軽いクライアント。統計量はドラッグが止まってから
 * 集計する（settle.ts）が、件数はドラッグ中も手元で増減が見えてほしいので、
 * count(*) だけを即時に数え直す（5万行でも数ミリ秒で済む）。
 */
export function connectLiveCount(
  db: Coordinator,
  tableName: string,
  $selected: Selection,
  onUpdate: (n: number) => void
) {
  makeClient({
    coordinator: db,
    filterStable: false, // 統計量の件数と1件単位で一致させるため、事前集計を使わせない
    selection: $selected,
    query: (filter) => Query.from(tableName).select({ n: count() }).where(filter),
    queryResult: (data: any) => onUpdate(Number(data.get(0).n)),
  });
}

export interface NumericComparison {
  column: string;
  selMean: number | null;
  restMean: number | null;
  restN: number;
  test: WelchResult | null;
}

/** 列ごとに選択中と選択外（母集団 − 選択中）を比べる。 */
export function compareNumeric(
  cols: string[],
  selected: StatsSnapshot,
  population: StatsSnapshot
): NumericComparison[] {
  return cols.map((column, i) => {
    const s = selected.columns[i];
    const p = population.columns[i];
    if (s.mean === null || p.mean === null || p.variance === null) {
      return { column, selMean: s.mean, restMean: null, restN: p.n - s.n, test: null };
    }
    const selGroup = { n: s.n, mean: s.mean, variance: s.variance ?? 0 };
    const rest = subtractGroup({ n: p.n, mean: p.mean, variance: p.variance }, selGroup);
    return {
      column,
      selMean: s.mean,
      restMean: rest?.mean ?? null,
      restN: rest?.n ?? 0,
      test: rest ? welchTTest(selGroup, rest) : null,
    };
  });
}

/**
 * 表示用の数値整形。桁の大きさに応じて小数桁を変える。
 * 固定で小数2桁にすると、1e-3 程度の測定値（濃度など）がすべて 0.00 に
 * 潰れてしまうため。
 */
export function formatStat(v: number | null): string {
  if (v === null) return '—';
  const abs = Math.abs(v);
  if (abs === 0) return '0';
  if (abs >= 1e6 || abs < 1e-3) return v.toExponential(2);
  const digits = abs >= 100 ? 1 : abs >= 1 ? 2 : 3;
  return v.toLocaleString('ja-JP', { maximumFractionDigits: digits });
}

// 効果量をバーで表示するときの端。これを超える差は端に張り付かせる
// （1.5 SD 以上ずれていれば、目で見て「大きく違う」と分かれば十分なため）。
const EFFECT_CLIP = 1.5;

function effectBar(d: number): string {
  const clipped = Math.max(-EFFECT_CLIP, Math.min(EFFECT_CLIP, d));
  const pct = (Math.abs(clipped) / EFFECT_CLIP) * 50;
  const side = d >= 0 ? `left:50%;width:${pct}%` : `left:${50 - pct}%;width:${pct}%`;
  const strength = { なし: 'weak', 小: 'weak', 中: 'medium', 大: 'strong' }[effectLabel(d)];
  return `<div class="effect-track"><div class="effect-bar ${d >= 0 ? 'pos' : 'neg'} ${strength}" style="${side}"></div></div>`;
}

/**
 * 要約統計量の表を描画する。行 = 数値列。
 *
 * 選択があるときは右側に「選択外の平均」「差（効果量 d）」「p 値」を並べる。
 * 生の平均差だと列ごとに単位が違って比べられないため、効果量（SD 単位）で
 * 「どの列が最も違うか」を一目で拾えるようにする。
 *
 * チャートで範囲を選ぶのに使った列には「選択に使用」の印を付ける。
 * その列で選んだのだから差が出るのは当然で、p 値は意味を持たない
 * （見た目で選んだ範囲に検定をかけると必ず有意になる）ことを明示するため。
 */
export function renderStatsTable(
  container: HTMLElement,
  cols: string[],
  selected: StatsSnapshot,
  population: StatsSnapshot,
  brushedCols: Set<string>,
  hasSelection: boolean
) {
  const comparisons = hasSelection ? compareNumeric(cols, selected, population) : [];

  const body = cols
    .map((c, i) => {
      const s = selected.columns[i];
      const missingRate = selected.rows > 0 ? s.missing / selected.rows : 0;
      const missingCell =
        s.missing > 0
          ? `<span class="missing-badge" title="${selected.rows.toLocaleString()} 件のうち ${s.missing.toLocaleString()} 件が欠測">${s.missing.toLocaleString()}<small>（${(missingRate * 100).toFixed(1)}%）</small></span>`
          : `<span class="muted">0</span>`;
      const brushedTag = brushedCols.has(c) ? '<span class="tag">選択に使用</span>' : '';

      let compareCells = '';
      if (hasSelection) {
        const cmp = comparisons[i];
        const test = cmp.test;
        const effectCell = test
          ? `<div class="effect" title="選択中の平均は選択外より ${test.d >= 0 ? '+' : ''}${test.d.toFixed(2)} SD（効果量: ${effectLabel(test.d)}）">
               ${effectBar(test.d)}<span class="effect-value">${test.d >= 0 ? '+' : ''}${test.d.toFixed(2)}</span>
             </div>`
          : '<span class="muted">—</span>';
        const pCell = test
          ? brushedCols.has(c)
            ? `<span class="muted" title="選択に使った列なので検定の意味がありません">（${formatP(test.p)}）</span>`
            : `<span class="${test.p < 0.05 ? 'sig' : 'muted'}">${formatP(test.p)}</span>`
          : '<span class="muted">—</span>';
        compareCells = `
          <td class="rest-col">${formatStat(cmp.restMean)}</td>
          <td class="effect-col">${effectCell}</td>
          <td>${pCell}</td>`;
      }

      return `<tr>
        <th scope="row">${escapeHtml(c)}${brushedTag}</th>
        <td>${s.n.toLocaleString()}</td>
        <td>${missingCell}</td>
        <td class="strong">${formatStat(s.mean)}</td>
        <td>${formatStat(s.variance === null ? null : Math.sqrt(s.variance))}</td>
        <td>${formatStat(s.min)}</td>
        <td>${formatStat(s.median)}</td>
        <td>${formatStat(s.max)}</td>
        ${compareCells}
      </tr>`;
    })
    .join('');

  const compareHead = hasSelection
    ? `<th scope="col" class="rest-col">選択外の平均</th>
       <th scope="col" class="effect-col">差（効果量 d）${helpTip('選択中と選択外の平均の差を、両群をまとめた標準偏差で割った値。単位の違う列どうしでも比べられる。目安は 0.2 小・0.5 中・0.8 大。')}</th>
       <th scope="col">p 値${helpTip('Welch の t 検定。差が偶然で生じる確率の目安で、0.05 未満なら「偶然とは考えにくい」とされる。件数が多いと小さな差でも小さくなるので、差の大きさは効果量 d で見る。')}</th>`
    : '';

  container.innerHTML = `
    <table class="stats-table">
      <thead>
        <tr>
          <th scope="col">列</th>
          <th scope="col">n${helpTip('欠測を除いた、実際に値がある件数。')}</th>
          <th scope="col">欠測${helpTip('値が空の件数。平均などはこの行を除いて計算している。')}</th>
          <th scope="col">平均</th>
          <th scope="col">SD${helpTip('標準偏差。値のばらつきの大きさ。')}</th>
          <th scope="col">最小</th>
          <th scope="col">中央値</th>
          <th scope="col">最大</th>
          ${compareHead}
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>`;
}
