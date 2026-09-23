// 件数と要約統計量（CLAUDE.md「次にやること」3）。
//
// 選択中（$brush）と母集団（$filter）それぞれに Mosaic クライアントを1つずつ
// 繋ぎ、フィルタやドラッグのたびに SQL 集計を DuckDB に投げ直す。
// 集計はすべて DuckDB 側で行い、JS 側へは1行の結果だけを持ってくる
// （行データを JS に取り出すと 100万行規模で破綻するため）。
//
// 欠測件数は Python版と同様に常に見える形にする。測定漏れがあるデータが
// 前提であり、平均などの値が「何件の値から計算されたか」を並べて示さないと
// 選択範囲の比較を誤読しやすいため。

import { makeClient } from '@uwdata/mosaic-core';
import type { Selection } from '@uwdata/mosaic-core';
import { Query, count, avg, stddev, min, max, median } from '@uwdata/mosaic-sql';
import type { Coordinator } from '@uwdata/vgplot';

export interface ColumnStats {
  n: number; // 非欠測の件数
  missing: number;
  mean: number | null;
  sd: number | null;
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
    select[`sd${i}`] = stddev(c);
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
        sd: toNumberOrNull(row[`sd${i}`]),
        min: toNumberOrNull(row[`min${i}`]),
        median: toNumberOrNull(row[`med${i}`]),
        max: toNumberOrNull(row[`max${i}`]),
      };
    }),
  };
}

export interface CountState {
  selected: number | null;
  population: number | null;
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
  $brush: Selection,
  onUpdate: (selected: StatsSnapshot | null, population: StatsSnapshot | null) => void
) {
  let selected: StatsSnapshot | null = null;
  let population: StatsSnapshot | null = null;

  makeClient({
    coordinator: db,
    selection: $filter,
    query: (filter) => statsQuery(tableName, numericCols, filter),
    queryResult: (data) => {
      population = parseStats(numericCols, data);
      onUpdate(selected, population);
    },
  });
  makeClient({
    coordinator: db,
    selection: $brush,
    query: (filter) => statsQuery(tableName, numericCols, filter),
    queryResult: (data) => {
      selected = parseStats(numericCols, data);
      onUpdate(selected, population);
    },
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

// 標準化差をバーで表示するときの端。これを超える偏りは端に張り付かせる
// （1.5 SD 以上ずれていれば、目で見て「大きく偏っている」と分かれば十分なため）。
const EFFECT_CLIP = 1.5;

function escapeHtml(value: string): string {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

/**
 * 要約統計量の表を描画する。行 = 数値列。
 *
 * 選択中の値を主に並べ、最後に「母集団との差」を標準化差
 * （(選択平均 − 母集団平均) / 母集団SD）で示す。生の差だと列ごとに
 * 単位が違って比べられないため、SD 単位に揃えて「どの列が選択によって
 * 最も偏ったか」を一目で拾えるようにする（探索的分析の入口として）。
 * 検定ではないので p 値は出さない（群間比較は「次にやること」4 で扱う）。
 */
export function renderStatsTable(
  container: HTMLElement,
  cols: string[],
  selected: StatsSnapshot | null,
  population: StatsSnapshot | null
) {
  if (!selected || !population) return;
  const isSubset = selected.rows < population.rows;

  const body = cols
    .map((c, i) => {
      const s = selected.columns[i];
      const p = population.columns[i];
      const missingRate = selected.rows > 0 ? s.missing / selected.rows : 0;
      const missingCell =
        s.missing > 0
          ? `<span class="missing-badge" title="選択中 ${selected.rows.toLocaleString()} 件のうち ${s.missing.toLocaleString()} 件が欠測">${s.missing.toLocaleString()}<small>（${(missingRate * 100).toFixed(1)}%）</small></span>`
          : `<span class="muted">0</span>`;

      let effectCell = '<span class="muted">—</span>';
      if (isSubset && s.mean !== null && p.mean !== null && p.sd && p.sd > 0) {
        const d = (s.mean - p.mean) / p.sd;
        const clipped = Math.max(-EFFECT_CLIP, Math.min(EFFECT_CLIP, d));
        const pct = (Math.abs(clipped) / EFFECT_CLIP) * 50;
        const side = d >= 0 ? `left:50%;width:${pct}%` : `left:${50 - pct}%;width:${pct}%`;
        const strength = Math.abs(d) >= 0.8 ? 'strong' : Math.abs(d) >= 0.3 ? 'medium' : 'weak';
        effectCell = `
          <div class="effect" title="選択中の平均は母集団より ${d >= 0 ? '+' : ''}${d.toFixed(2)} SD">
            <div class="effect-track"><div class="effect-bar ${d >= 0 ? 'pos' : 'neg'} ${strength}" style="${side}"></div></div>
            <span class="effect-value">${d >= 0 ? '+' : ''}${d.toFixed(2)}</span>
          </div>`;
      }

      return `<tr>
        <th scope="row">${escapeHtml(c)}</th>
        <td>${s.n.toLocaleString()}</td>
        <td>${missingCell}</td>
        <td>${formatStat(s.mean)}</td>
        <td>${formatStat(s.sd)}</td>
        <td>${formatStat(s.min)}</td>
        <td>${formatStat(s.median)}</td>
        <td>${formatStat(s.max)}</td>
        <td class="pop-col">${formatStat(p.mean)}</td>
        <td class="effect-col">${effectCell}</td>
      </tr>`;
    })
    .join('');

  container.innerHTML = `
    <table class="stats-table">
      <thead>
        <tr>
          <th scope="col">列</th>
          <th scope="col" title="欠測を除いた件数">n</th>
          <th scope="col">欠測</th>
          <th scope="col">平均</th>
          <th scope="col" title="標本標準偏差">SD</th>
          <th scope="col">最小</th>
          <th scope="col">中央値</th>
          <th scope="col">最大</th>
          <th scope="col" class="pop-col">母集団の平均</th>
          <th scope="col" class="effect-col" title="(選択中の平均 − 母集団の平均) ÷ 母集団のSD">母集団との差（SD）</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>`;
}
