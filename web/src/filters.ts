// フィルタパネル：チャートの選択（マーキング）とは別系統の絞り込み。
//
// 役割分担:
//   フィルタ   … 母集団そのものを絞る（このモジュール、$filter Selection）
//   チャート選択 … 絞られた母集団の「中で」ドラッグして選ぶ（$brush Selection）
//
// Mosaic では $brush（Selection.crossfilter）を作るときに
// `include: [$filter]` を渡すことで、$filter に書き込まれた条件が常に
// $brush 側にも合流する。これにより、チャート側は常に「フィルタを通過した
// 母集団の中で」 crossfilter される（Python版の「フィルタ後の DataFrame を
// 単一の source of truth にする」設計と同じ効果を、Selection の合成で実現する）。
//
// Python版 (src/filters.py, src/data.py) からの移植であり、
// 高カーディナリティ列の除外閾値・欠測の扱いは同じ方針を踏襲している。

import type { Coordinator } from '@uwdata/vgplot';
import { Selection } from '@uwdata/mosaic-core';
import { or, isBetween, isIn, isNull, literal } from '@uwdata/mosaic-sql';
import type { SelectionClause } from '@uwdata/mosaic-core';

// チェックボックス・色分けの対象から外す、カテゴリ列の最大ユニーク値数。
// 根拠: Bokeh の既定カテゴリパレット Category20 が持つ色数（20）。
// これを超えると色分けは色が循環して区別できなくなり、チェックボックスも
// 縦に長くなって一覧性を失う。Python版の MAX_CATEGORY_CARDINALITY と同じ値・
// 同じ根拠（web/CLAUDE.md「決まっていること」は行数の閾値の話で、これとは別）。
export const MAX_CATEGORY_CARDINALITY = 20;

export interface ColumnMeta {
  name: string;
  type: string; // DuckDB の型文字列（DESCRIBE の column_type）
}

const NUMERIC_TYPE_RE =
  /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|DECIMAL|REAL)/i;

export function isNumericType(duckType: string): boolean {
  return NUMERIC_TYPE_RE.test(duckType);
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export interface ClassifiedColumns {
  numericCols: string[];
  catCols: string[]; // フィルタ・色分けの対象（低カーディナリティ）
  highCardCols: { name: string; cardinality: number }[]; // 除外した列と件数
}

/**
 * 列を数値/カテゴリに分け、カテゴリ列のうちユニーク値が多すぎる列を除外する。
 * 除外判定に必要な distinct 件数は、対象列をまとめて1クエリで取得する
 * （列数分クエリを投げるとテーブルスキャンが列数倍になるため）。
 */
export async function classifyColumns(
  db: Coordinator,
  tableName: string,
  columns: ColumnMeta[]
): Promise<ClassifiedColumns> {
  const numericCols = columns.filter((c) => isNumericType(c.type)).map((c) => c.name);
  const catCandidates = columns.filter((c) => !isNumericType(c.type)).map((c) => c.name);

  const catCols: string[] = [];
  const highCardCols: { name: string; cardinality: number }[] = [];

  if (catCandidates.length > 0) {
    const selects = catCandidates
      .map((c) => `count(DISTINCT ${quoteIdent(c)}) AS ${quoteIdent(c)}`)
      .join(', ');
    const result: any = await db.query(`SELECT ${selects} FROM ${quoteIdent(tableName)}`, {
      cache: false,
    });
    const row = result.get(0);
    for (const c of catCandidates) {
      const n = Number(row[c]);
      if (n > MAX_CATEGORY_CARDINALITY) {
        highCardCols.push({ name: c, cardinality: n });
      } else {
        catCols.push(c);
      }
    }
  }

  return { numericCols, catCols, highCardCols };
}

export interface NumericFilter {
  column: string;
  min: number;
  max: number;
  element: HTMLElement;
}

export interface CategoryFilter {
  column: string;
  options: string[];
  element: HTMLElement;
}

export interface FilterPanel {
  element: HTMLElement;
  numeric: NumericFilter[];
  categorical: CategoryFilter[];
}

/**
 * 数値レンジフィルタの節（clause）を作る。
 *
 * pandas 版で踏んだ不具合と同じ理由で、欠測（NULL）は無条件で通す。
 * SQL の `BETWEEN` は NULL に対して NULL（=偽扱い）を返すため、素直に
 * `isBetween` だけを使うと、フィルタを一切操作していなくても欠測を含む
 * 行だけ母集団から消えてしまう。`OR col IS NULL` を必ず添えることで、
 * 「初期状態は全件を通す」を欠測ありのデータでも成立させる。
 */
function numericRangeClause(column: string, lo: number, hi: number, source: object): SelectionClause {
  const predicate = or([isBetween(column, [lo, hi]), isNull(column)]);
  return { source, fields: [], value: [lo, hi], predicate };
}

/**
 * カテゴリチェックボックスの節を作る。数値レンジと同じ理由で、
 * 欠測は選択肢に関わらず無条件で通す。
 */
function categoryInClause(column: string, selected: string[], source: object): SelectionClause {
  const predicate = or([isIn(column, selected.map((v) => literal(v))), isNull(column)]);
  return { source, fields: [], value: selected, predicate };
}

/**
 * フィルタパネルの DOM を組み立て、ウィジェット操作を $filter Selection への
 * 書き込みに配線する。数値列はレンジスライダー（下限・上限の2本）、
 * カテゴリ列はチェックボックス群。
 *
 * 初期値は「全件を通す」状態（フル範囲・全選択）にする。フィルタパネルを
 * 開いた直後に母集団が意図せず絞られないようにするため（Python版と同じ方針）。
 */
export async function buildFilterPanel(
  db: Coordinator,
  tableName: string,
  cols: ClassifiedColumns,
  filterSelection: Selection
): Promise<FilterPanel> {
  const container = document.createElement('div');
  const numeric: NumericFilter[] = [];
  const categorical: CategoryFilter[] = [];

  for (const col of cols.numericCols) {
    const row: any = (
      await db.query(
        `SELECT min(${quoteIdent(col)}) AS lo, max(${quoteIdent(col)}) AS hi FROM ${quoteIdent(tableName)}`,
        { cache: false }
      )
    ).get(0);
    const lo = Number(row.lo);
    const hi = Number(row.hi);

    const wrap = document.createElement('div');
    wrap.className = 'filter-item';
    const label = document.createElement('label');
    label.textContent = col;
    const lowInput = document.createElement('input');
    const highInput = document.createElement('input');
    const valueLabel = document.createElement('span');
    valueLabel.className = 'filter-range-value';

    const step = hi > lo ? (hi - lo) / 200 : 1;
    for (const input of [lowInput, highInput]) {
      input.type = 'range';
      input.min = String(lo);
      input.max = String(hi);
      input.step = String(step || 1);
    }
    lowInput.value = String(lo);
    highInput.value = String(hi);

    const source = { kind: 'numeric-filter', column: col };
    const publish = () => {
      let a = Number(lowInput.value);
      let b = Number(highInput.value);
      if (a > b) [a, b] = [b, a]; // 下限が上限を追い越したら入れ替えて扱う
      valueLabel.textContent = `${formatNumber(a)} 〜 ${formatNumber(b)}`;
      filterSelection.update(numericRangeClause(col, a, b, source));
    };
    lowInput.addEventListener('input', publish);
    highInput.addEventListener('input', publish);
    valueLabel.textContent = `${formatNumber(lo)} 〜 ${formatNumber(hi)}`;

    wrap.append(label, lowInput, highInput, valueLabel);
    container.appendChild(wrap);
    numeric.push({ column: col, min: lo, max: hi, element: wrap });
  }

  for (const col of cols.catCols) {
    const result: any = await db.query(
      `SELECT DISTINCT ${quoteIdent(col)} AS v FROM ${quoteIdent(tableName)} WHERE ${quoteIdent(col)} IS NOT NULL ORDER BY v`,
      { cache: false }
    );
    const options: string[] = result.toArray().map((r: any) => String(r.v));

    const wrap = document.createElement('div');
    wrap.className = 'filter-item';
    const label = document.createElement('label');
    label.textContent = col;
    wrap.appendChild(label);

    const checkboxes: HTMLInputElement[] = [];
    const source = { kind: 'category-filter', column: col };
    const publish = () => {
      const selected = checkboxes.filter((cb) => cb.checked).map((cb) => cb.value);
      filterSelection.update(categoryInClause(col, selected, source));
    };
    for (const opt of options) {
      const optLabel = document.createElement('label');
      optLabel.className = 'filter-checkbox';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = opt;
      cb.checked = true; // 初期状態は全選択（全件を通す）
      cb.addEventListener('change', publish);
      checkboxes.push(cb);
      optLabel.append(cb, document.createTextNode(opt));
      wrap.appendChild(optLabel);
    }

    container.appendChild(wrap);
    categorical.push({ column: col, options, element: wrap });
  }

  // 初期状態（全件を通す）を明示的に発行する。
  // フィルタと選択は別系統だが、初期状態でも $filter に何らかの節が
  // 積まれている状態にしておくことで、後段の母集団カウント等が
  // 「フィルタなし」を特別扱いせずに済む。
  for (const n of numeric) {
    filterSelection.update(numericRangeClause(n.column, n.min, n.max, { kind: 'numeric-filter', column: n.column }));
  }
  for (const c of categorical) {
    filterSelection.update(categoryInClause(c.column, c.options, { kind: 'category-filter', column: c.column }));
  }

  return { element: container, numeric, categorical };
}

function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/**
 * フィルタパネルを完全に作り直す（別ファイルを読み込んだときに呼ぶ）。
 * 古いパネルの DOM を捨て、$filter Selection も新規に作り直すことで、
 * 古い列に対する条件（clause）が新しいテーブルに引き継がれないようにする。
 * clause は column 名の文字列を直接埋め込んでいるだけで、新しい $filter
 * インスタンスには何も積まれていない状態からスタートする。
 */
export function newFilterSelection(): Selection {
  return Selection.intersect();
}
