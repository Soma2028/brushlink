// 単回帰（CLAUDE.md「次にやること」4）。
//
// 散布図の X/Y に対する最小二乗の直線を、母集団と選択中の両方について求める。
// 傾き・切片・R² は DuckDB の regr_* 集計関数で計算し、JS 側へは1行だけ
// 持ってくる（行データを取り出さないので、raster 表示の100万行でも同じ速さ）。
// 散布図上の直線そのものは vgplot の regressionY マーク（charts.ts）が描く。

import { makeClient } from '@uwdata/mosaic-core';
import type { Selection } from '@uwdata/mosaic-core';
import { Query, regrSlope, regrIntercept, regrR2, regrCount, corr, stddev } from '@uwdata/mosaic-sql';
import type { Coordinator } from '@uwdata/vgplot';
import { correlationPValue, formatP } from './inference';
import { escapeHtml, helpTip } from './dom';
import { formatStat } from './stats';

export interface RegressionResult {
  n: number;
  slope: number | null;
  intercept: number | null;
  r2: number | null;
  r: number | null;
  sdX: number | null;
}

function regressionQuery(tableName: string, x: string, y: string, filter: any) {
  // 注意: Mosaic の regrSlope(a, b) は DuckDB の regr_slope(a, b) にそのまま
  // 渡る。DuckDB の regr_* は (従属変数 Y, 独立変数 X) の順なので、Y を先に渡す
  return Query.from(tableName)
    .select({
      n: regrCount(y, x),
      slope: regrSlope(y, x),
      intercept: regrIntercept(y, x),
      r2: regrR2(y, x),
      r: corr(y, x),
      sdX: stddev(x),
    })
    .where(filter);
}

function parse(data: any): RegressionResult {
  const row = data.get(0);
  const num = (v: unknown) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    n: Number(row.n),
    slope: num(row.slope),
    intercept: num(row.intercept),
    r2: num(row.r2),
    r: num(row.r),
    sdX: num(row.sdX),
  };
}

export function connectRegressionClients(
  db: Coordinator,
  tableName: string,
  x: string,
  y: string,
  $filter: Selection,
  $selected: Selection,
  onUpdate: (selected: RegressionResult | null, population: RegressionResult | null) => void
) {
  let selected: RegressionResult | null = null;
  let population: RegressionResult | null = null;
  makeClient({
    coordinator: db,
    // 事前集計（preaggregation）を使わせない。Mosaic の事前集計はブラシの
    // 範囲を画面のピクセル単位に丸めて集計するため、描画には十分でも
    // 件数や平均が厳密な値から1件単位でずれる（統計量として出す値には不適）
    filterStable: false,
    selection: $filter,
    query: (filter) => regressionQuery(tableName, x, y, filter),
    queryResult: (data) => {
      population = parse(data);
      onUpdate(selected, population);
    },
  });
  makeClient({
    coordinator: db,
    filterStable: false, // 上と同じ理由で事前集計を使わせない
    selection: $selected,
    query: (filter) => regressionQuery(tableName, x, y, filter),
    queryResult: (data) => {
      selected = parse(data);
      onUpdate(selected, population);
    },
  });
}

/**
 * 「X が ○ 増えると Y は平均 △ 変わる」の ○ に使う切りの良い幅。
 * 「1 増えると」固定だと、値域が 0.8〜1.6 の列では現実にない変化量になり、
 * 値域が 0〜100万の列では小さすぎて意味が伝わらない。X の標準偏差に近い
 * 10 の累乗を使い、データの実際のばらつきに見合った幅で言い換える。
 */
function niceStep(sdX: number | null): number {
  if (!sdX || !(sdX > 0)) return 1;
  return 10 ** Math.round(Math.log10(sdX));
}

function strengthWord(r: number): string {
  const a = Math.abs(r);
  if (a >= 0.7) return '強い';
  if (a >= 0.4) return '中程度の';
  if (a >= 0.2) return '弱い';
  return 'ほとんどない';
}

function describe(label: string, res: RegressionResult, x: string, y: string, accent: boolean): string {
  if (res.n < 3 || res.slope === null || res.intercept === null || res.r === null) {
    return `<div class="reg-row"><span class="reg-label ${accent ? 'accent' : ''}">${label}</span><span class="muted">件数が少なく計算できません（n = ${res.n}）</span></div>`;
  }
  const step = niceStep(res.sdX);
  const change = res.slope * step;
  const p = correlationPValue(res.r, res.n);
  const relation = Math.abs(res.r) < 0.2 ? '相関は' : res.r > 0 ? '正の相関が' : '負の相関が';
  const sentence =
    Math.abs(res.r) < 0.2
      ? `${escapeHtml(x)} と ${escapeHtml(y)} の${relation}${strengthWord(res.r)}`
      : `${escapeHtml(x)} が ${formatStat(step)} 増えると、${escapeHtml(y)} は平均 ${formatStat(Math.abs(change))} ${change >= 0 ? '増える' : '減る'}（${strengthWord(res.r)}${relation.replace('が', '')}）`;
  const sign = res.intercept >= 0 ? '+' : '−';
  return `
    <div class="reg-row">
      <span class="reg-label ${accent ? 'accent' : ''}">${label}</span>
      <span class="reg-sentence">${sentence}</span>
      <span class="reg-detail">
        <code>${escapeHtml(y)} = ${formatStat(res.slope)} × ${escapeHtml(x)} ${sign} ${formatStat(Math.abs(res.intercept))}</code>
        R² = ${res.r2 === null ? '—' : res.r2.toFixed(3)} ・ r = ${res.r.toFixed(3)} ・ p ${p !== null && p < 0.001 ? '' : '= '}${formatP(p)} ・ n = ${res.n.toLocaleString()}
      </span>
    </div>`;
}

export function renderRegression(
  container: HTMLElement,
  x: string,
  y: string,
  selected: RegressionResult,
  population: RegressionResult,
  hasSelection: boolean
) {
  container.innerHTML = `
    <div class="reg-head">単回帰${helpTip('散布図の点に最もよく当てはまる直線（最小二乗法）。R² は直線で説明できるばらつきの割合（0〜1）、r は相関係数（−1〜1）。直線の周りの帯は 95% 信頼区間。')}</div>
    ${describe('母集団', population, x, y, false)}
    ${hasSelection ? describe('選択中', selected, x, y, true) : ''}`;
}
