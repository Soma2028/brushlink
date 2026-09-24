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
import { quoteIdent } from './sql';

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

// 日付・時刻の型。カテゴリとしては扱わず、折れ線グラフの横軸に使う
const TEMPORAL_TYPE_RE = /^(DATE|TIMESTAMP|TIME)/i;
// 整数の型。「順序」（測定回・日数など）として折れ線の横軸にも使える
const INTEGER_TYPE_RE = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT)/i;

export function isTemporalType(duckType: string): boolean {
  return TEMPORAL_TYPE_RE.test(duckType);
}

export interface ClassifiedColumns {
  numericCols: string[];
  catCols: string[]; // フィルタ・色分けの対象（低カーディナリティ）
  highCardCols: { name: string; cardinality: number }[]; // 除外した列と件数
  temporalCols: string[]; // 日付・時刻（折れ線の横軸）
  orderCols: string[]; // 整数の数値列（折れ線の横軸にも使える順序）
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
  const orderCols = columns.filter((c) => INTEGER_TYPE_RE.test(c.type)).map((c) => c.name);
  const temporalCols = columns.filter((c) => isTemporalType(c.type)).map((c) => c.name);
  const catCandidates = columns
    .filter((c) => !isNumericType(c.type) && !isTemporalType(c.type))
    .map((c) => c.name);

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

  return { numericCols, catCols, highCardCols, temporalCols, orderCols };
}

// 数値レンジスライダーの分解能。値域を何段階で動かせるか。
// 200 段なら値域の 0.5% 刻みで、サイドバー幅（約 280px）のスライダーでは
// 1段がほぼ 1〜2px に相当し、これ以上細かくしてもマウスで狙えないため。
const SLIDER_STEPS = 200;

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
  // この部品が $filter に書き込む節の出どころ。初期状態の節も同じ source で出し、
  // 後の操作や作り直しで確実に置き換わる（別の source だと古い節が残り続ける）
  source: object;
}

export interface FilterPanel {
  element: HTMLElement;
  numeric: NumericFilter[];
  categorical: CategoryFilter[];
  // すべてのフィルタを初期状態（全件を通す）に戻す
  reset: () => void;
  // カテゴリ列の絞り込みを後から足す（同じ列が既にあれば作り直す）。
  // 機械学習で「クラスタ」列を書き戻したとき、その列でも絞り込めるようにするため
  setCategoryColumn: (column: string) => Promise<void>;
}

/**
 * 数値レンジフィルタの節（clause）を作る。
 *
 * pandas 版で踏んだ不具合と同じ理由で、`includeNulls` が true の間は
 * 欠測（NULL）を無条件で通す。SQL の `BETWEEN` は NULL に対して
 * NULL（=偽扱い）を返すため、素直に `isBetween` だけを使うと、
 * フィルタを一切操作していなくても欠測を含む行だけ母集団から消えてしまう。
 * `OR col IS NULL` を添えることで、「初期状態は全件を通す」を欠測ありの
 * データでも成立させる。`includeNulls` は「欠測を含める」チェックボックス
 * （既定オン）で列ごとに切り替えられ、オフにすると素の `isBetween` になる。
 */
function numericRangeClause(
  column: string,
  lo: number,
  hi: number,
  source: object,
  includeNulls: boolean
): SelectionClause {
  const base = isBetween(column, [lo, hi]);
  const predicate = includeNulls ? or([base, isNull(column)]) : base;
  return { source, fields: [], value: [lo, hi], predicate };
}

/**
 * カテゴリチェックボックスの節を作る。数値レンジと同じ理由・同じ
 * `includeNulls` の扱い方で、欠測を通すかどうかを列ごとに切り替えられる。
 */
function categoryInClause(
  column: string,
  selected: string[],
  source: object,
  includeNulls: boolean
): SelectionClause {
  const base = isIn(column, selected.map((v) => literal(v)));
  const predicate = includeNulls ? or([base, isNull(column)]) : base;
  return { source, fields: [], value: selected, predicate };
}

// 「欠測を含める」チェックボックスがオンになっている列（かつ実際に欠測が
// ある列）の一覧。件数表示の近くに出す注記の材料にするため main.ts に渡す。
export interface MissingIncludedEntry {
  column: string;
  nullCount: number;
}

/**
 * フィルタパネルの DOM を組み立て、ウィジェット操作を $filter Selection への
 * 書き込みに配線する。数値列はレンジスライダー（下限・上限の2本）、
 * カテゴリ列はチェックボックス群。列ごとに欠測（NULL）があれば
 * 「欠測を含める」チェックボックス（既定オン）を添える。
 *
 * 初期値は「全件を通す」状態（フル範囲・全選択・欠測を含める）にする。
 * フィルタパネルを開いた直後に母集団が意図せず絞られないようにするため
 * （Python版と同じ方針）。
 *
 * `onMissingIncludedChange` は「欠測を含める」チェックボックスの状態が
 * 変わるたび（初回構築の直後も含む）に呼ばれ、現在含めている列の一覧を渡す。
 * main.ts 側はこれを件数表示の近くの注記に反映するだけで、欠測の扱いの
 * ロジック自体はこのモジュールに閉じている。
 */
export async function buildFilterPanel(
  db: Coordinator,
  tableName: string,
  cols: ClassifiedColumns,
  filterSelection: Selection,
  onMissingIncludedChange: (entries: MissingIncludedEntry[]) => void,
  onActiveChange: (descriptions: string[]) => void = () => {}
): Promise<FilterPanel> {
  const container = document.createElement('div');
  const numeric: NumericFilter[] = [];
  const categorical: CategoryFilter[] = [];

  // フィルタ対象の列（数値・カテゴリ）の欠測件数を1クエリでまとめて取る
  // （classifyColumns の distinct 件数取得と同じ理由で、列数分クエリを
  // 投げるとテーブルスキャンが列数倍になるのを避ける）。
  const filterableCols = [...cols.numericCols, ...cols.catCols];
  const nullCounts: Record<string, number> = {};
  if (filterableCols.length > 0) {
    const selects = filterableCols
      .map((c) => `count(*) - count(${quoteIdent(c)}) AS ${quoteIdent(c)}`)
      .join(', ');
    const result: any = await db.query(`SELECT ${selects} FROM ${quoteIdent(tableName)}`, {
      cache: false,
    });
    const row = result.get(0);
    for (const c of filterableCols) {
      nullCounts[c] = Number(row[c]);
    }
  }

  // 「欠測を含める」チェックボックスがある列（欠測が実在する列）の現在の状態。
  // チェックボックスを出さない列（欠測なし）は常に true 扱いでよい
  // （OR IS NULL を足しても該当行がないので害がない）。
  const includeNullsByCol = new Map<string, boolean>();
  function notifyMissingIncluded() {
    const entries: MissingIncludedEntry[] = [];
    for (const [column, included] of includeNullsByCol) {
      if (included) entries.push({ column, nullCount: nullCounts[column] });
    }
    onMissingIncludedChange(entries);
  }

  // 各フィルタの「初期状態に戻す」処理。パネル全体のリセットボタンから呼ぶ
  const resetters: (() => void)[] = [];
  // 各フィルタの現在の条件を短い文にする処理。効いていなければ null。
  // 件数の横に「いま何で絞っているか」を出すのと、書き出す図の注記に使う
  const describers: (() => string | null)[] = [];
  function notifyActive() {
    onActiveChange(describers.map((d) => d()).filter((d): d is string => d !== null));
  }

  /**
   * 「欠測を含める」チェックボックスを作る。欠測が実在しない列には出さない
   * （無意味なトグルを見せないため）。
   */
  function addNullsToggle(wrap: HTMLElement, col: string, publish: () => void) {
    if (!(nullCounts[col] > 0)) return;
    includeNullsByCol.set(col, true);
    const nullsLabel = document.createElement('label');
    nullsLabel.className = 'filter-nulls-toggle';
    const nullsCheckbox = document.createElement('input');
    nullsCheckbox.type = 'checkbox';
    nullsCheckbox.checked = true;
    nullsCheckbox.addEventListener('change', () => {
      includeNullsByCol.set(col, nullsCheckbox.checked);
      publish();
      notifyMissingIncluded();
    });
    nullsLabel.append(
      nullsCheckbox,
      document.createTextNode(`欠測 ${nullCounts[col].toLocaleString()} 件を含める`)
    );
    wrap.appendChild(nullsLabel);
    resetters.push(() => {
      nullsCheckbox.checked = true;
      includeNullsByCol.set(col, true);
    });
  }

  function filterHeader(col: string, kindLabel: string): { head: HTMLElement; value: HTMLElement } {
    const head = document.createElement('div');
    head.className = 'filter-head';
    const label = document.createElement('span');
    label.className = 'filter-name';
    label.textContent = col;
    label.title = col;
    const kind = document.createElement('span');
    kind.className = 'filter-kind';
    kind.textContent = kindLabel;
    const value = document.createElement('span');
    value.className = 'filter-range-value';
    head.append(label, kind, value);
    return { head, value };
  }

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
    const { head, value: valueLabel } = filterHeader(col, '数値');

    // 下限・上限の2本のスライダーを1本の軌道に重ねる（デュアルスライダー）。
    // 2本を縦に並べるより「どこからどこまで」が一目で分かるため。
    // ブラウザ標準の range を2つ重ね、つまみ以外はクリックを透過させる
    // （外部の UI ライブラリを足さずに済ませるため）。
    const slider = document.createElement('div');
    slider.className = 'dual-range';
    const track = document.createElement('div');
    track.className = 'dual-range-track';
    const fill = document.createElement('div');
    fill.className = 'dual-range-fill';
    track.appendChild(fill);
    const lowInput = document.createElement('input');
    const highInput = document.createElement('input');
    lowInput.setAttribute('aria-label', `${col} の下限`);
    highInput.setAttribute('aria-label', `${col} の上限`);

    // スライダー自体は 0〜SLIDER_STEPS の整数位置で持ち、値へは toValue で
    // 写す。range に小数の min/max/step を直接渡すと、ブラウザが値を
    // step の整数倍に丸める際の浮動小数点誤差で右端が1ステップ手前になり、
    // つまみを動かしていないのに最大値の行が母集団から落ちるため。
    // 端の位置は必ず真の最小値・最大値に写す。
    const toValue = (pos: number): number =>
      pos <= 0 ? lo : pos >= SLIDER_STEPS ? hi : lo + ((hi - lo) * pos) / SLIDER_STEPS;
    for (const input of [lowInput, highInput]) {
      input.type = 'range';
      input.min = '0';
      input.max = String(SLIDER_STEPS);
      input.step = '1';
    }
    lowInput.value = '0';
    highInput.value = String(SLIDER_STEPS);
    slider.append(track, lowInput, highInput);

    const source = { kind: 'numeric-filter', column: col };
    const publish = () => {
      let a = toValue(Number(lowInput.value));
      let b = toValue(Number(highInput.value));
      if (a > b) [a, b] = [b, a]; // 下限が上限を追い越したら入れ替えて扱う
      valueLabel.textContent = `${formatNumber(a)} 〜 ${formatNumber(b)}`;
      const span = hi > lo ? hi - lo : 1;
      fill.style.left = `${((a - lo) / span) * 100}%`;
      fill.style.right = `${((hi - b) / span) * 100}%`;
      // 範囲を狭めたか、欠測を外したときに「効いているフィルタ」として目立たせる
      const narrowed = a > lo || b < hi || includeNullsByCol.get(col) === false;
      wrap.classList.toggle('is-active', narrowed);
      filterSelection.update(numericRangeClause(col, a, b, source, includeNullsByCol.get(col) ?? true));
      current = narrowed
        ? `${col}: ${formatNumber(a)}〜${formatNumber(b)}${includeNullsByCol.get(col) === false ? '（欠測を除く）' : ''}`
        : null;
      notifyActive();
    };
    let current: string | null = null;
    describers.push(() => current);
    lowInput.addEventListener('input', publish);
    highInput.addEventListener('input', publish);
    valueLabel.textContent = `${formatNumber(lo)} 〜 ${formatNumber(hi)}`;

    wrap.append(head, slider);
    addNullsToggle(wrap, col, publish);
    resetters.push(() => {
      lowInput.value = '0';
      highInput.value = String(SLIDER_STEPS);
      publish();
    });

    container.appendChild(wrap);
    numeric.push({ column: col, min: lo, max: hi, element: wrap });
  }

  // 作り直しで捨てたカテゴリの部品の片付け（列名 → 片付ける関数）
  const disposers = new Map<string, () => void>();

  async function addCategoryWidget(col: string, publishNow: boolean) {
    let alive = true;
    const result: any = await db.query(
      `SELECT DISTINCT ${quoteIdent(col)} AS v FROM ${quoteIdent(tableName)} WHERE ${quoteIdent(col)} IS NOT NULL ORDER BY v`,
      { cache: false }
    );
    const options: string[] = result.toArray().map((r: any) => String(r.v));

    const wrap = document.createElement('div');
    wrap.className = 'filter-item';
    const { head, value: valueLabel } = filterHeader(col, 'カテゴリ');

    // 全選択/全解除の切り替え。20種近いカテゴリから1つだけ残したいときに、
    // 19回クリックさせないため
    const toggleAll = document.createElement('button');
    toggleAll.type = 'button';
    toggleAll.className = 'link-button';
    head.appendChild(toggleAll);

    const chips = document.createElement('div');
    chips.className = 'filter-chips';

    const checkboxes: HTMLInputElement[] = [];
    const source = { kind: 'category-filter', column: col };
    const publish = () => {
      const selected = checkboxes.filter((cb) => cb.checked).map((cb) => cb.value);
      valueLabel.textContent = `${selected.length}/${options.length}`;
      toggleAll.textContent = selected.length === options.length ? '全解除' : '全選択';
      const narrowed = selected.length < options.length || includeNullsByCol.get(col) === false;
      wrap.classList.toggle('is-active', narrowed);
      filterSelection.update(categoryInClause(col, selected, source, includeNullsByCol.get(col) ?? true));
      const shown = selected.length <= 3 ? selected.join('・') || 'なし' : `${selected.length}/${options.length} 種`;
      current = narrowed
        ? `${col}: ${shown}${includeNullsByCol.get(col) === false ? '（欠測を除く）' : ''}`
        : null;
      notifyActive();
    };
    let current: string | null = null;
    describers.push(() => (alive ? current : null));
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
      chips.appendChild(optLabel);
    }
    toggleAll.addEventListener('click', () => {
      const allOn = checkboxes.every((cb) => cb.checked);
      for (const cb of checkboxes) cb.checked = !allOn;
      publish();
    });
    valueLabel.textContent = `${options.length}/${options.length}`;
    toggleAll.textContent = '全解除';

    wrap.append(head, chips);
    addNullsToggle(wrap, col, publish);
    resetters.push(() => {
      if (!alive) return;
      for (const cb of checkboxes) cb.checked = true;
      publish();
    });

    container.appendChild(wrap);
    const entry = { column: col, options, element: wrap, source };
    categorical.push(entry);
    disposers.set(col, () => {
      alive = false;
      wrap.remove();
      categorical.splice(categorical.indexOf(entry), 1);
      // この部品が $filter に入れていた条件を取り除く
      filterSelection.update({ source, value: null, predicate: null } as unknown as SelectionClause);
    });
    if (publishNow) {
      filterSelection.update(categoryInClause(col, options, source, true));
      notifyActive();
    }
  }

  for (const col of cols.catCols) await addCategoryWidget(col, false);

  // 初期状態（全件を通す。欠測も含める）を明示的に発行する。
  // フィルタと選択は別系統だが、初期状態でも $filter に何らかの節が
  // 積まれている状態にしておくことで、後段の母集団カウント等が
  // 「フィルタなし」を特別扱いせずに済む。
  for (const n of numeric) {
    filterSelection.update(
      numericRangeClause(n.column, n.min, n.max, { kind: 'numeric-filter', column: n.column }, true)
    );
  }
  for (const c of categorical) {
    filterSelection.update(categoryInClause(c.column, c.options, c.source, true));
  }
  notifyMissingIncluded();

  function reset() {
    for (const r of resetters) r();
    notifyMissingIncluded();
  }

  async function setCategoryColumn(column: string) {
    disposers.get(column)?.();
    disposers.delete(column);
    // 新しい列の欠測件数（「欠測を含める」を出すかどうかの判断に使う）
    const row: any = (
      await db.query(`SELECT count(*) - count(${quoteIdent(column)}) AS m FROM ${quoteIdent(tableName)}`, { cache: false })
    ).get(0);
    nullCounts[column] = Number(row.m);
    includeNullsByCol.delete(column);
    await addCategoryWidget(column, true);
    notifyMissingIncluded();
  }

  return { element: container, numeric, categorical, reset, setCategoryColumn };
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
