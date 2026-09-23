// グラフの種類と、列の型から「描けるグラフ」を決める規則。
//
// 画面では先に X・Y の列を選び、その型の組み合わせで意味をなすグラフだけを
// 種類の選択肢に出す（意味のない組み合わせは選べないようにする）。
// ここは DOM にも DuckDB にも触れない純粋な規則だけを置く。
//
// どの種類も $filter（母集団）と $brush（選択）に参加し、数値の軸は範囲の
// ドラッグ、カテゴリの軸はクリックで選択する。連動に参加できないグラフは
// 種類に加えない（CLAUDE.md「決まっていること」）。
// 箱ひげ図は vgplot に対応するマークが無いため加えていない（charts.ts 参照）。

export type ChartType = 'scatter' | 'histogram' | 'bar-count' | 'bar-mean' | 'errorbar' | 'line';

export type ColumnKind = 'numeric' | 'category' | 'temporal' | 'none';

export const CHART_LABELS: Record<ChartType, string> = {
  scatter: '散布図',
  histogram: 'ヒストグラム',
  'bar-count': '棒グラフ（件数）',
  'bar-mean': '棒グラフ（平均）',
  errorbar: '平均±誤差棒',
  line: '折れ線（平均）',
};

// 選択のしかた（グラフの上に出す操作の案内に使う）
export const CHART_HINTS: Record<ChartType, string> = {
  scatter: '四角くドラッグして選択',
  histogram: '横にドラッグして選択',
  'bar-count': '棒をクリックして選択（Shift で複数）',
  'bar-mean': '棒をクリックして選択（Shift で複数）',
  errorbar: '平均の点をクリックして選択（Shift で複数）',
  line: '横にドラッグして選択',
};

export interface ChartConfig {
  id: number;
  type: ChartType;
  x: string;
  y: string | null;
  color: string | null; // 散布図の色分け列
  regression: boolean; // 散布図に回帰直線を重ねるか
  error: 'se' | 'sd'; // 誤差棒の誤差の種類（標準誤差 / 標準偏差）
}

export interface ColumnKinds {
  numeric: string[];
  category: string[];
  temporal: string[];
  order: string[]; // 整数の数値列（折れ線の横軸にも使える）
}

export function kindOf(kinds: ColumnKinds, column: string | null): ColumnKind {
  if (column === null) return 'none';
  if (kinds.numeric.includes(column)) return 'numeric';
  if (kinds.category.includes(column)) return 'category';
  if (kinds.temporal.includes(column)) return 'temporal';
  return 'none';
}

/**
 * X・Y 列の組み合わせで描けるグラフ。先頭が既定（自動で選ぶもの）。
 *
 * - 数値 × 数値 → 散布図（整数の X なら折れ線も。「順序」として読めるため）
 * - 数値 × なし → ヒストグラム
 * - カテゴリ × なし → 棒グラフ（件数）
 * - カテゴリ × 数値 → 平均±誤差棒、棒グラフ（平均）
 * - 日付 × 数値 → 折れ線
 * カテゴリは X にだけ置く（縦向きの誤差棒・棒グラフに揃えるため）。
 */
export function availableTypes(kinds: ColumnKinds, x: string, y: string | null): ChartType[] {
  const kx = kindOf(kinds, x);
  const ky = kindOf(kinds, y);
  if (kx === 'numeric' && ky === 'numeric') {
    return kinds.order.includes(x) ? ['scatter', 'line'] : ['scatter'];
  }
  if (kx === 'numeric' && ky === 'none') return ['histogram'];
  if (kx === 'category' && ky === 'none') return ['bar-count'];
  if (kx === 'category' && ky === 'numeric') return ['errorbar', 'bar-mean'];
  if (kx === 'temporal' && ky === 'numeric') return ['line'];
  return [];
}

/**
 * X に選んだ列の型から、Y に選べる列。カテゴリ・日付の列は Y に置かない
 * （意味のない組み合わせを選択肢から外す）。日付の X には数値の Y が必須。
 */
export function yOptions(kinds: ColumnKinds, x: string): { allowNone: boolean; columns: string[] } {
  const kx = kindOf(kinds, x);
  if (kx === 'temporal') return { allowNone: false, columns: kinds.numeric };
  return { allowNone: true, columns: kinds.numeric.filter((c) => c !== x) };
}

export function xOptions(kinds: ColumnKinds): string[] {
  return [...kinds.numeric, ...kinds.category, ...kinds.temporal];
}

let nextChartId = 1;

export function newChart(partial: Omit<Partial<ChartConfig>, 'id'> & { type: ChartType; x: string }): ChartConfig {
  return {
    id: nextChartId++,
    y: null,
    color: null,
    regression: true,
    error: 'se',
    ...partial,
  };
}

export interface InitialLayoutInput {
  kinds: ColumnKinds;
  bestPair: { x: string; y: string } | null; // 相関が最も強い数値2列
  bestGroup: { category: string; numeric: string } | null; // 群間差が最も大きいカテゴリ×数値
}

/**
 * 読み込み直後に並べるグラフを、列の型から自動で決める（製品方針「初期状態は
 * 自動で組み立てる」）。
 * - 数値が2列以上 → 相関の最も強い2列の散布図と、その2列のヒストグラム
 * - カテゴリと数値がある → 群間の差が最も大きい組み合わせの平均±誤差棒
 * - 数値が1列だけ → そのヒストグラム / 数値が無い → 最初のカテゴリの件数の棒グラフ
 */
export function initialLayout({ kinds, bestPair, bestGroup }: InitialLayoutInput): ChartConfig[] {
  const charts: ChartConfig[] = [];
  const firstCat = kinds.category[0] ?? null;
  if (bestPair) {
    charts.push(newChart({ type: 'scatter', x: bestPair.x, y: bestPair.y, color: firstCat }));
  }
  if (bestGroup) {
    charts.push(newChart({ type: 'errorbar', x: bestGroup.category, y: bestGroup.numeric }));
  }
  if (bestPair) {
    charts.push(newChart({ type: 'histogram', x: bestPair.x }));
    charts.push(newChart({ type: 'histogram', x: bestPair.y }));
  } else if (kinds.numeric.length === 1) {
    charts.push(newChart({ type: 'histogram', x: kinds.numeric[0] }));
  }
  if (charts.length === 0 && firstCat) charts.push(newChart({ type: 'bar-count', x: firstCat }));
  return charts;
}

/**
 * 「グラフを追加」で足す1枚。まだ画面に無い組み合わせを優先して選ぶ
 * （同じグラフが2枚並ぶより、別の列が見えた方が探索の役に立つため）。
 */
export function suggestNextChart(kinds: ColumnKinds, existing: ChartConfig[]): ChartConfig | null {
  const has = (type: ChartType, x: string, y: string | null = null) =>
    existing.some((c) => c.type === type && c.x === x && c.y === y);
  for (const x of kinds.numeric) if (!has('histogram', x)) return newChart({ type: 'histogram', x });
  for (const cat of kinds.category) {
    for (const num of kinds.numeric) if (!has('errorbar', cat, num)) return newChart({ type: 'errorbar', x: cat, y: num });
  }
  for (const cat of kinds.category) if (!has('bar-count', cat)) return newChart({ type: 'bar-count', x: cat });
  if (kinds.numeric[0]) return newChart({ type: 'histogram', x: kinds.numeric[0] });
  if (kinds.category[0]) return newChart({ type: 'bar-count', x: kinds.category[0] });
  return null;
}
