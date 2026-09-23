// カテゴリ列の構成比の比較（CLAUDE.md「次にやること」4 の群間比較のカテゴリ版）。
//
// 数値列は平均の差で比べられるが、カテゴリ列（ライン・材料など）は
// 「選んだ範囲にどのカテゴリが多いか」で比べる。Spotfire で範囲を選んだ後に
// 棒グラフの色の偏りを見るのと同じ問いを、構成比の帯と χ² 検定で答える。

import { makeClient } from '@uwdata/mosaic-core';
import type { Selection } from '@uwdata/mosaic-core';
import { Query, count, literal, cast } from '@uwdata/mosaic-sql';
import type { Coordinator } from '@uwdata/vgplot';
import { chiSquareTest, formatP } from './inference';
import type { ChiSquareResult } from './inference';
import { escapeHtml, helpTip } from './dom';

// 欠測（NULL）のカテゴリを表す表示名。構成比から欠測を黙って落とさないため、
// ひとつのカテゴリとして扱う
export const MISSING_LABEL = '（欠測）';

// 散布図の色分けと同じ配色（vgplot の tableau10）。カテゴリの並び順も
// Plot の既定（値の昇順）に揃え、散布図の凡例と同じ色が同じカテゴリを指すようにする
export const PALETTE = ['#4e79a7', '#f28e2c', '#e15759', '#76b7b2', '#59a14f', '#edc949', '#af7aa1', '#ff9da7', '#9c755f', '#bab0ab'];
const MISSING_COLOR = '#c9ced6';

/** 列ごとのカテゴリ別件数。キーは列名、値は カテゴリ → 件数。 */
export type CategoryCounts = Map<string, Map<string, number>>;

/**
 * 全カテゴリ列の件数を1クエリ（UNION ALL）で取る。数値列の統計量と同じく、
 * 列ごとにクエリを分けるとドラッグのたびに列数分スキャンが走るため。
 */
function countsQuery(tableName: string, cols: string[], filter: any) {
  const queries = cols.map((c, i) =>
    Query.from(tableName)
      .select({ c: literal(i), v: cast(c, 'VARCHAR'), n: count() })
      .where(filter)
      .groupby(cast(c, 'VARCHAR'))
  );
  return queries.length === 1 ? queries[0] : Query.unionAll(...queries);
}

function parseCounts(cols: string[], data: any): CategoryCounts {
  const result: CategoryCounts = new Map(cols.map((c) => [c, new Map<string, number>()]));
  for (const row of data.toArray()) {
    const col = cols[Number(row.c)];
    const key = row.v === null || row.v === undefined ? MISSING_LABEL : String(row.v);
    result.get(col)!.set(key, Number(row.n));
  }
  return result;
}

export function connectCategoryClients(
  db: Coordinator,
  tableName: string,
  catCols: string[],
  $filter: Selection,
  $selected: Selection,
  onUpdate: (selected: CategoryCounts | null, population: CategoryCounts | null) => void
) {
  if (catCols.length === 0) return;
  let selected: CategoryCounts | null = null;
  let population: CategoryCounts | null = null;
  makeClient({
    coordinator: db,
    // 事前集計（preaggregation）を使わせない。Mosaic の事前集計はブラシの
    // 範囲を画面のピクセル単位に丸めて集計するため、描画には十分でも
    // 件数や平均が厳密な値から1件単位でずれる（統計量として出す値には不適）
    filterStable: false,
    selection: $filter,
    query: (filter) => countsQuery(tableName, catCols, filter),
    queryResult: (data) => {
      population = parseCounts(catCols, data);
      onUpdate(selected, population);
    },
  });
  makeClient({
    coordinator: db,
    filterStable: false, // 上と同じ理由で事前集計を使わせない
    selection: $selected,
    query: (filter) => countsQuery(tableName, catCols, filter),
    queryResult: (data) => {
      selected = parseCounts(catCols, data);
      onUpdate(selected, population);
    },
  });
}

export interface CategoryComparison {
  column: string;
  categories: string[]; // 表示順（値の昇順、欠測は末尾）
  selected: number[];
  rest: number[];
  test: ChiSquareResult | null;
  // 選択中で構成比が最も増えたカテゴリ（文章要約用）
  topShift: { category: string; selShare: number; restShare: number } | null;
}

function orderedCategories(pop: Map<string, number>): string[] {
  const keys = [...pop.keys()].filter((k) => k !== MISSING_LABEL).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (pop.has(MISSING_LABEL)) keys.push(MISSING_LABEL);
  return keys;
}

export function compareCategories(
  cols: string[],
  selected: CategoryCounts,
  population: CategoryCounts
): CategoryComparison[] {
  return cols.map((column) => {
    const pop = population.get(column) ?? new Map<string, number>();
    const sel = selected.get(column) ?? new Map<string, number>();
    const categories = orderedCategories(pop);
    const selCounts = categories.map((k) => sel.get(k) ?? 0);
    // 選択外 = 母集団 − 選択中（選択中は母集団の部分集合）
    const restCounts = categories.map((k, i) => Math.max(0, (pop.get(k) ?? 0) - selCounts[i]));
    const selTotal = selCounts.reduce((s, v) => s + v, 0);
    const restTotal = restCounts.reduce((s, v) => s + v, 0);

    let topShift: CategoryComparison['topShift'] = null;
    if (selTotal > 0 && restTotal > 0) {
      categories.forEach((category, i) => {
        const selShare = selCounts[i] / selTotal;
        const restShare = restCounts[i] / restTotal;
        if (!topShift || selShare - restShare > topShift.selShare - topShift.restShare) {
          topShift = { category, selShare, restShare };
        }
      });
    }
    return {
      column,
      categories,
      selected: selCounts,
      rest: restCounts,
      test: selTotal > 0 && restTotal > 0 ? chiSquareTest([selCounts, restCounts]) : null,
      topShift,
    };
  });
}

function colorFor(categories: string[], index: number): string {
  if (categories[index] === MISSING_LABEL) return MISSING_COLOR;
  return PALETTE[index % PALETTE.length];
}

function stackedBar(label: string, counts: number[], categories: string[]): string {
  const total = counts.reduce((s, v) => s + v, 0);
  const segments = counts
    .map((n, i) => {
      if (n === 0 || total === 0) return '';
      const share = (n / total) * 100;
      const text = share >= 9 ? `${share.toFixed(0)}%` : '';
      return `<div class="stack-seg" style="width:${share}%;background:${colorFor(categories, i)}" title="${escapeHtml(categories[i])}: ${n.toLocaleString()} 件（${share.toFixed(1)}%）">${text}</div>`;
    })
    .join('');
  return `<div class="stack-row"><span class="stack-label">${label}<small>${total.toLocaleString()} 件</small></span><div class="stack">${segments || '<div class="stack-empty">0 件</div>'}</div></div>`;
}

/**
 * カテゴリ構成の比較を描画する。列ごとに「選択中」「選択外」の2本の
 * 100% 積み上げ帯を並べ、構成比の偏りを見比べられるようにする。
 * 選択が無いときは母集団の構成を1本だけ出す。
 */
export function renderCategoryComparison(
  container: HTMLElement,
  cols: string[],
  selected: CategoryCounts,
  population: CategoryCounts,
  hasSelection: boolean
) {
  if (cols.length === 0) {
    container.innerHTML = '<p class="muted">カテゴリ列がありません（数値以外の列で、種類が20以下のもの）。</p>';
    return;
  }
  const comparisons = compareCategories(cols, selected, population);
  container.innerHTML = comparisons
    .map((cmp) => {
      const legend = cmp.categories
        .map(
          (k, i) =>
            `<span class="legend-item"><span class="swatch" style="background:${colorFor(cmp.categories, i)}"></span>${escapeHtml(k)}</span>`
        )
        .join('');
      const popCounts = cmp.selected.map((s, i) => s + cmp.rest[i]);
      const bars = hasSelection
        ? stackedBar('選択中', cmp.selected, cmp.categories) + stackedBar('選択外', cmp.rest, cmp.categories)
        : stackedBar('母集団', popCounts, cmp.categories);
      const testText =
        hasSelection && cmp.test
          ? `<span class="${cmp.test.p < 0.05 ? 'sig' : 'muted'}">χ² 検定 p ${cmp.test.p < 0.001 ? '' : '= '}${formatP(cmp.test.p)}・関連の強さ V = ${cmp.test.cramersV.toFixed(2)}</span>`
          : '';
      return `
        <div class="cat-block">
          <div class="cat-head"><strong>${escapeHtml(cmp.column)}</strong>${testText}</div>
          ${bars}
          <div class="legend">${legend}</div>
        </div>`;
    })
    .join('');
  if (hasSelection) {
    container.insertAdjacentHTML(
      'afterbegin',
      `<p class="hint">選択中と選択外で、カテゴリの構成比を比べています。${helpTip('χ² 検定は構成比の違いが偶然かどうかの目安（0.05 未満で偶然とは考えにくい）。V は 0〜1 の関連の強さで、0.1 小・0.3 中・0.5 大が目安。')}</p>`
    );
  }
}
