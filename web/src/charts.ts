// チャート生成。散布図（dot/raster 自動切替・回帰直線）、ヒストグラム、
// 棒グラフ（件数・平均）、平均±誤差棒、折れ線。種類と列の組み合わせの規則は
// chartTypes.ts、画面への並べ方は chartGrid.ts。
//
// どの種類も同じ2層構成にしてある: 灰色の層が母集団（$filter のみで絞る）、
// 色付きの層が選択中（$brush で絞る。カテゴリのグラフだけは $selected で、
// 理由は CategoryChartContext に書いた）。選択の操作は、数値の軸なら範囲の
// ドラッグ（intervalX / intervalXY）、カテゴリの軸ならクリック（toggleX）で、
// どちらも $brush に書き込むので、すべてのグラフと統計量が連動する。
//
// vgplot に無いマークは作らない。箱ひげ図は vgplot（mosaic-plot）に対応する
// マークが無く、ひげの端（四分位範囲の1.5倍以内で最も外側の値）は集計関数
// 1つでは求まらないため、既存マークの組み合わせでは正しい箱ひげ図にならない。
// よって種類に加えていない。

import type { Coordinator } from '@uwdata/vgplot';
import { quoteIdent } from './sql';
import {
  Selection,
  plot,
  dot,
  raster,
  rectY,
  bin,
  count,
  from,
  intervalX,
  intervalXY,
  width,
  height,
  name,
  colorLegend,
  colorScheme,
  xLabel,
  yLabel,
  regressionY,
  colorDomain,
  barY,
  ruleX,
  lineY,
  toggleX,
  xDomain,
  ruleY,
  xAxis,
  yAxis,
  xTicks,
  yTicks,
  marginLeft,
  marginBottom,
  marginTop,
  marginRight,
} from '@uwdata/vgplot';
import { avg, stddev, sqrt, div, sub, add, sql, column as col } from '@uwdata/mosaic-sql';


// dot と raster の自動切替閾値。ユーザーには選ばせず、行数から自動判定する
// （CLAUDE.md「決まっていること」）。
//
// 根拠: docs/performance.md「1万〜10万行の再計測」。ヒストグラムをドラッグして
// いる間に最も長く止まった1フレーム（long task）は、dot では行数にほぼ比例して
// 伸び、1万行 51ms → 1.5万行 76ms → 2万行 93〜109ms → 5万行 278ms。
// raster は 1万〜10万行を通じて long task が出なかった。入力への応答が
// 100ms を超えると遅れとして体感されるので、100ms を明確に下回った最大の
// 計測点 15,000 を閾値にした（以前の 50,000 は、1万〜10万を計測しないまま
// 置いた暫定値で、計測すると 5万行では毎フレーム約 280ms 止まっていた）。
export const DOT_TO_RASTER_THRESHOLD = 15_000;

/**
 * カテゴリ列 × 数値列の組み合わせのうち、群間の差が最も大きいものを選ぶ。
 * 誤差棒の初期表示を自動で組み立てるため（散布図の軸を相関で選ぶのと同じ考え方）。
 * 差の大きさは相関比 η²（群間平方和 ÷ 全平方和）で測る。組み合わせが多いと
 * テーブルを何度も走査するので、カテゴリ列は先頭5列、数値列は先頭10列までに絞る。
 */
export async function pickBestGroup(
  db: Coordinator,
  tableName: string,
  catCols: string[],
  numericCols: string[]
): Promise<{ category: string; numeric: string; eta2: number } | null> {
  const pairs: [string, string][] = [];
  for (const c of catCols.slice(0, 5)) for (const n of numericCols.slice(0, 10)) pairs.push([c, n]);
  if (pairs.length === 0) return null;
  const t = quoteIdent(tableName);
  const selects = pairs.map(([c, n], idx) => {
    const qc = quoteIdent(c);
    const qn = quoteIdent(n);
    return `SELECT ${idx} AS idx, (
        SELECT sum(g.cnt * (g.m - tot.m) * (g.m - tot.m)) / nullif(max(tot.sst), 0)
        FROM (SELECT count(${qn}) AS cnt, avg(${qn}) AS m FROM ${t} WHERE ${qn} IS NOT NULL AND ${qc} IS NOT NULL GROUP BY ${qc}) g,
             (SELECT avg(${qn}) AS m, var_pop(${qn}) * count(${qn}) AS sst FROM ${t} WHERE ${qn} IS NOT NULL AND ${qc} IS NOT NULL) tot
      ) AS eta2`;
  });
  const result: any = await db.query(
    `SELECT * FROM (${selects.join(' UNION ALL ')}) ORDER BY eta2 DESC NULLS LAST LIMIT 1`,
    { cache: false }
  );
  const row = result.toArray()[0];
  if (!row || row.eta2 === null) return null;
  const [category, numeric] = pairs[Number(row.idx)];
  return { category, numeric, eta2: Number(row.eta2) };
}

export interface AxisPair {
  x: string;
  y: string;
  r: number | null; // 選んだ2列の相関係数（画面で「なぜこの2列か」を説明するため）
}

/**
 * 数値列の中から、相関係数の絶対値が最も高い2列を選ぶ。
 * X/Y軸の初期値をユーザーに考えさせず自動生成するため（製品方針）。
 * 全ペアの corr() を1クエリ（UNION ALL）にまとめて計算する。
 */
export async function pickBestAxisPair(
  db: Coordinator,
  tableName: string,
  numericCols: string[]
): Promise<AxisPair> {
  if (numericCols.length < 2) {
    throw new Error('数値列が2つ以上ないため軸を選べません。');
  }

  const pairs: [string, string][] = [];
  for (let i = 0; i < numericCols.length; i++) {
    for (let j = i + 1; j < numericCols.length; j++) {
      pairs.push([numericCols[i], numericCols[j]]);
    }
  }

  const selects = pairs
    .map(
      ([a, b], idx) =>
        `SELECT ${idx} AS idx, corr(${quoteIdent(a)}, ${quoteIdent(b)}) AS r FROM ${quoteIdent(tableName)}`
    )
    .join(' UNION ALL ');
  // UNION の結果に式（abs）で ORDER BY するには、UNION をサブクエリに包む必要がある
  const result: any = await db.query(`SELECT * FROM (${selects}) ORDER BY abs(r) DESC NULLS LAST LIMIT 1`, {
    cache: false,
  });
  const rows = result.toArray();
  if (rows.length === 0) return { x: numericCols[0], y: numericCols[1], r: null };
  const [x, y] = pairs[Number(rows[0].idx)];
  const r = rows[0].r === null ? null : Number(rows[0].r);
  return { x, y, r };
}

// 母集団のうち選択されていない部分を描く背景色。Spotfire のマーキングと
// 同じく、選択外を消してしまわず薄く残すことで「全体の中のどこを選んだか」
// を見失わないようにする。
const BACKGROUND_FILL = '#d4d8de';
// 色分けしないときの前景色（style.css の --accent と揃える）
const ACCENT_FILL = '#2563eb';
// ブラシ（選択範囲の枠）の見た目。既定の濃い灰色の塗りだと枠の中の
// 選択中の点がくすんで見えるため、薄いアクセント色の塗りと枠線にする。
// 属性として付くので、図の書き出し（export.ts）にもそのまま反映される
const BRUSH_STYLE = { fill: ACCENT_FILL, fillOpacity: 0.07, stroke: ACCENT_FILL, strokeWidth: 1.5 };
// 母集団の層の線・点の色（背景の塗りより少し濃くして、誤差棒や折れ線でも見えるように）
const POPULATION_STROKE = '#9aa3b2';


export interface ScatterConfig {
  tableName: string;
  x: string;
  y: string;
  colorCol: string | null;
  // 色分け列の全カテゴリ（絞り込み前）。固定しないと、絞り込みでカテゴリが
  // 消えるたびに Plot が残りのカテゴリで色を振り直し、同じカテゴリの色が変わる
  colorValues: unknown[] | null;
  rowCount: number;
  population: Selection; // フィルタ後の母集団（$filter）
  brush: Selection; // チャート間のマーキング（$brush、crossfilter）
  // 散布図自身の範囲選択も含めた選択（$selected、intersect）。回帰直線用
  selected: Selection;
  showRegression: boolean;
  plotName: string; // 凡例を紐づけるための名前
  width: number;
  height: number;
}

/**
 * 散布図を組み立てる。行数が DOT_TO_RASTER_THRESHOLD 以上なら
 * raster、未満なら dot。ユーザーに選ばせる UI は作らない。
 *
 * dot のときは2層にする: 背景に母集団（$filter のみ）を灰色で、前景に
 * マーキング後（$brush）を色付きで重ねる。こうすると他のチャートで
 * 選択したとき、散布図上では「選ばれた点が色付きで浮き上がる」表示になる。
 * raster は2層重ねると下の層が完全に隠れるうえ描画コストが倍になるため、
 * 1層のままにする（大規模データでは応答速度を優先する）。
 */
export function buildScatterPlot(cfg: ScatterConfig): HTMLElement {
  const useRaster = cfg.rowCount >= DOT_TO_RASTER_THRESHOLD;
  const fg = from(cfg.tableName, { filterBy: cfg.brush });

  const marks = useRaster
    ? [raster(fg, { x: cfg.x, y: cfg.y, pixelSize: 2 })]
    : [
        dot(from(cfg.tableName, { filterBy: cfg.population }), {
          x: cfg.x,
          y: cfg.y,
          fill: BACKGROUND_FILL,
          r: 2.5,
        }),
        dot(fg, {
          x: cfg.x,
          y: cfg.y,
          fill: cfg.colorCol ?? ACCENT_FILL,
          r: 2.5,
          fillOpacity: 0.8,
        }),
      ];

  // 回帰直線: 母集団（灰）と選択中（アクセント色）の2本。選択中の直線は
  // $brush ではなく $selected で絞る。$brush は crossfilter なので、散布図
  // 自身の範囲選択が散布図上のマークには効かず、散布図で囲んだ範囲の
  // 直線が引けないため（intersect の $selected なら自身の選択も効く）
  const regression = cfg.showRegression
    ? [
        regressionY(from(cfg.tableName, { filterBy: cfg.population }), {
          x: cfg.x,
          y: cfg.y,
          stroke: '#7b8494',
          strokeWidth: 1.5,
          strokeDasharray: '5 3',
          fill: '#7b8494',
          fillOpacity: 0.12,
        }),
        regressionY(from(cfg.tableName, { filterBy: cfg.selected }), {
          x: cfg.x,
          y: cfg.y,
          stroke: '#1d4ed8',
          strokeWidth: 2.5,
          fill: '#1d4ed8',
          fillOpacity: 0.15,
        }),
      ]
    : [];

  return plot(
    ...marks,
    ...regression,
    intervalXY({ as: cfg.brush, brush: BRUSH_STYLE }),
    name(cfg.plotName),
    xLabel(`${cfg.x} →`),
    yLabel(`↑ ${cfg.y}`),
    // カテゴリ色のスキームは dot の色分けにだけ使う。raster は密度を連続色で
    // 塗るため、カテゴリ用スキームを渡すと補間関数が無く描画に失敗する
    ...(useRaster ? [] : [colorScheme('tableau10')]),
    ...(!useRaster && cfg.colorCol && cfg.colorValues ? [colorDomain(cfg.colorValues)] : []),
    width(cfg.width),
    height(cfg.height)
  );
}

/** 散布図の色分け列の凡例。凡例は plot の外に別要素として置く（vgplot の仕様）。 */
export function buildColorLegend(plotName: string): HTMLElement {
  return colorLegend({ for: plotName });
}

/**
 * ヒストグラム。散布図と同じ理由で、母集団（灰色）とマーキング後（色付き）を
 * 重ねる。ビン境界は両層とも列全体の範囲から決まるので、2層の棒は揃う。
 */
export function buildHistogram(
  tableName: string,
  column: string,
  population: Selection,
  brush: Selection,
  size: { width: number; height: number }
): HTMLElement {
  return plot(
    rectY(from(tableName, { filterBy: population }), {
      x: bin(column),
      y: count(),
      fill: BACKGROUND_FILL,
      inset: 0.5,
    }),
    rectY(from(tableName, { filterBy: brush }), {
      x: bin(column),
      y: count(),
      fill: ACCENT_FILL,
      inset: 0.5,
    }),
    intervalX({ as: brush, brush: BRUSH_STYLE }),
    xLabel(`${column} →`),
    yLabel('件数'),
    width(size.width),
    height(size.height)
  );
}

export interface CategoryChartContext {
  tableName: string;
  population: Selection;
  brush: Selection;
  // 色付きの層（選択中）を絞る Selection。カテゴリのグラフだけは $brush ではなく
  // $selected（intersect）を使う。crossfilter の $brush は「自分のグラフで
  // クリックした選択を自分には効かせない」ので、クリックしても自分の棒は
  // 全部色付きのままで、どれを選んだか分からない。intersect なら、クリック
  // したカテゴリだけが色付きで残り、他は灰色になる（他のグラフと同じ見え方）。
  // vgplot の highlight でも同じことをしようとしたが、highlight は選択の条件を
  // 集計済みの行に当てはめるため、$brush に合流している絞り込みの条件
  // （集計のキーではない列の範囲）で SQL が失敗し、グラフが描けなかった。
  // 集計済みの少ない行を引き直すだけなので、即時に追従させても軽い
  selected: Selection;
  // 横軸に並べるカテゴリ（絞り込み前の全カテゴリ）。固定しないと、絞り込みで
  // カテゴリが消えるたびに並びと位置が変わり、クリックしたい棒が動いてしまう
  categories: unknown[];
  size: { width: number; height: number };
}

function categoryDomain(values: unknown[]): unknown[] {
  // 欠測（NULL）のカテゴリはクリックで選べない（等号で比べられない）ので軸に出さない
  return values.filter((v) => v !== null && v !== undefined);
}

/**
 * 棒グラフ（件数）。カテゴリの棒をクリックして選ぶ。
 *
 * クリックの受け手（toggleX）は、常に全カテゴリが揃っている母集団の層にする。
 * 選択中の層を受け手にすると、他のグラフの選択で件数が0になったカテゴリは
 * 棒が消えてクリックできなくなるため。選択中の層は上に重なるので
 * pointerEvents: none にして、クリックを下の母集団の層へ通す。
 */
export function buildBarCount(column: string, ctx: CategoryChartContext): HTMLElement {
  return plot(
    barY(from(ctx.tableName, { filterBy: ctx.population }), { x: column, y: count(), fill: BACKGROUND_FILL, inset: 2 }),
    toggleX({ as: ctx.brush }),
    barY(from(ctx.tableName, { filterBy: ctx.selected }), {
      x: column,
      y: count(),
      fill: ACCENT_FILL,
      inset: 2,
      pointerEvents: 'none',
    }),
    xDomain(categoryDomain(ctx.categories)),
    // カテゴリ軸の見出しは目盛りのラベルと重なるので出さない（列名はカードの見出しにある）
    xLabel(null),
    yLabel('↑ 件数'),
    width(ctx.size.width),
    height(ctx.size.height)
  );
}

/**
 * 棒グラフ（平均）。灰色の太い棒が母集団の平均、その上に重ねた細い棒が
 * 選択中の平均。重ねて幅を変えることで、2つの平均を同じ位置で見比べられる。
 */
export function buildBarMean(column: string, value: string, ctx: CategoryChartContext): HTMLElement {
  return plot(
    barY(from(ctx.tableName, { filterBy: ctx.population }), { x: column, y: avg(value), fill: BACKGROUND_FILL, inset: 2 }),
    toggleX({ as: ctx.brush }),
    barY(from(ctx.tableName, { filterBy: ctx.selected }), {
      x: column,
      y: avg(value),
      fill: ACCENT_FILL,
      inset: 10,
      pointerEvents: 'none',
    }),
    xDomain(categoryDomain(ctx.categories)),
    // カテゴリ軸の見出しは目盛りのラベルと重なるので出さない（列名はカードの見出しにある）
    xLabel(null),
    yLabel(`↑ ${value}（平均）`),
    width(ctx.size.width),
    height(ctx.size.height)
  );
}

/**
 * 平均±誤差棒。誤差は標準誤差（SE = SD / √n）が既定で、標準偏差（SD）に
 * 切り替えられる。SE は「平均がどれだけ確かか」、SD は「個々の値がどれだけ
 * ばらつくか」で、比較の目的によって使い分けるため。
 *
 * vgplot の errorbarY マークは「平均 ± 信頼水準に応じた倍数 × SE」しか描けず、
 * SD を選べない。そのため、vgplot の既存マーク ruleX（縦線）と dot（点）に、
 * 平均・SD・SE の SQL 集計式を直接渡して描いている（新しいマークは作っていない）。
 * 母集団（灰）と選択中（青）を左右に少しずらして並べる。
 *
 * クリックの受け手は、母集団の平均の位置に置いた見えない大きな点。
 * 線や小さな点だけだと細すぎてクリックしにくいため。
 */
export function buildErrorBar(column: string, value: string, error: 'se' | 'sd', ctx: CategoryChartContext): HTMLElement {
  const err = error === 'se' ? div(stddev(value), sqrt(count(value))) : stddev(value);
  const low = sub(avg(value), err);
  const high = add(avg(value), err);
  const pop = from(ctx.tableName, { filterBy: ctx.population });
  const sel = from(ctx.tableName, { filterBy: ctx.selected });
  const OFFSET = 7;
  return plot(
    ruleX(pop, { x: column, y1: low, y2: high, stroke: POPULATION_STROKE, strokeWidth: 2, dx: -OFFSET, pointerEvents: 'none' }),
    dot(pop, { x: column, y: avg(value), fill: POPULATION_STROKE, r: 4.5, dx: -OFFSET, pointerEvents: 'none' }),
    ruleX(sel, { x: column, y1: low, y2: high, stroke: ACCENT_FILL, strokeWidth: 2.5, dx: OFFSET, pointerEvents: 'none' }),
    dot(sel, { x: column, y: avg(value), fill: ACCENT_FILL, r: 5, dx: OFFSET, pointerEvents: 'none' }),
    // クリックの受け手（見えない大きな点）
    dot(pop, { x: column, y: avg(value), r: 22, fill: ACCENT_FILL, fillOpacity: 0 }),
    toggleX({ as: ctx.brush }),
    xDomain(categoryDomain(ctx.categories)),
    // カテゴリ軸の見出しは目盛りのラベルと重なるので出さない（列名はカードの見出しにある）
    xLabel(null),
    yLabel(`↑ ${value}（平均 ± ${error === 'se' ? '標準誤差' : '標準偏差'}）`),
    width(ctx.size.width),
    height(ctx.size.height)
  );
}

/**
 * 折れ線（横軸の値ごとの平均）。横軸は日付・時刻、または整数（順序）の列。
 * 数値の軸なので、範囲の選択は横方向のドラッグ。
 */
export function buildLine(
  column: string,
  value: string,
  ctx: Omit<CategoryChartContext, 'categories' | 'selected'>
): HTMLElement {
  return plot(
    lineY(from(ctx.tableName, { filterBy: ctx.population }), {
      x: column,
      y: avg(value),
      stroke: POPULATION_STROKE,
      strokeWidth: 1.5,
      curve: 'monotone-x',
    }),
    lineY(from(ctx.tableName, { filterBy: ctx.brush }), {
      x: column,
      y: avg(value),
      stroke: ACCENT_FILL,
      strokeWidth: 2.5,
      curve: 'monotone-x',
    }),
    intervalX({ as: ctx.brush, brush: BRUSH_STYLE }),
    xLabel(`${column} →`),
    yLabel(`↑ ${value}（平均）`),
    width(ctx.size.width),
    height(ctx.size.height)
  );
}

export interface ResidualContext {
  tableName: string;
  rowCount: number;
  population: Selection;
  brush: Selection;
  size: { width: number; height: number };
}

/**
 * 回帰の残差プロット。横軸が X、縦軸が残差（Y − 回帰直線の予測値）。
 * 回帰直線は母集団で当てはめたもの（slope・intercept）を定数として式に埋め込む。
 * 残差は SQL の式として DuckDB で計算するので、点の数・描き方（dot / raster の
 * 自動切替）・範囲選択は散布図と同じ扱いになる。縦方向の選択は「残差の範囲」
 * として $brush に入る（残差の大きい外れ値だけを選ぶ、といった使い方ができる）。
 * 母集団が変わると直線も変わるので、呼び出し側（chartGrid.ts）が作り直す。
 */
export function buildResidual(
  x: string,
  y: string,
  fit: { slope: number; intercept: number },
  ctx: ResidualContext
): HTMLElement {
  const residual = sql`${col(y)} - (${fit.slope} * ${col(x)} + ${fit.intercept})`;
  const useRaster = ctx.rowCount >= DOT_TO_RASTER_THRESHOLD;
  const fg = from(ctx.tableName, { filterBy: ctx.brush });
  const marks = useRaster
    ? [raster(fg, { x, y: residual, pixelSize: 2 })]
    : [
        dot(from(ctx.tableName, { filterBy: ctx.population }), { x, y: residual, fill: BACKGROUND_FILL, r: 2.5 }),
        dot(fg, { x, y: residual, fill: ACCENT_FILL, r: 2.5, fillOpacity: 0.8 }),
      ];
  return plot(
    // 残差0の基準線は先に描く。interactor（intervalXY）は直前のマークの列を
    // 選択の対象にするので、基準線（列を持たない）を最後にすると、範囲選択の
    // 条件が「NULL BETWEEN …」になって何も選べなくなる
    ruleY([0], { stroke: POPULATION_STROKE, strokeDasharray: '5 3' }),
    ...marks,
    intervalXY({ as: ctx.brush, brush: BRUSH_STYLE }),
    xLabel(`${x} →`),
    yLabel(`↑ 残差（${y} − 予測値）`),
    width(ctx.size.width),
    height(ctx.size.height)
  );
}

export interface SplomContext {
  tableName: string;
  rowCount: number;
  population: Selection;
  brush: Selection;
  width: number;
}

/**
 * 散布図行列。選んだ列の全ペアの小さな散布図を格子に並べ、対角にはその列の
 * ヒストグラムを置く。どのマスでもドラッグで範囲を選べ、$brush に入る。
 *
 * dot / raster の切り替えは、行数ではなく「描き直す点の総数」（行数 × 対角以外の
 * マスの数）で判定する。閾値 DOT_TO_RASTER_THRESHOLD の根拠は「1回の選択で
 * 描き直す点が何個までなら止まらないか」の計測なので、マスが増えた分だけ
 * 点の総数で比べるのが同じ基準になる。
 * vgplot の plot を複数並べるので、個々の plot 要素の配列も返す（リサイズ用）。
 */
export function buildSplom(columns: string[], ctx: SplomContext): { element: HTMLElement; plots: HTMLElement[] } {
  const k = columns.length;
  const cell = Math.max(90, Math.floor((ctx.width - 12) / k));
  const offDiagonal = k * (k - 1);
  const useRaster = ctx.rowCount * offDiagonal >= DOT_TO_RASTER_THRESHOLD;
  const grid = document.createElement('div');
  grid.className = 'splom';
  grid.style.gridTemplateColumns = `repeat(${k}, ${cell}px)`;
  const plots: HTMLElement[] = [];
  columns.forEach((yCol, row) => {
    columns.forEach((xCol, colIndex) => {
      const edgeLeft = colIndex === 0;
      const edgeBottom = row === k - 1;
      const common = [
        width(cell),
        height(cell),
        marginLeft(edgeLeft ? 40 : 8),
        marginBottom(edgeBottom ? 34 : 8),
        marginTop(8),
        marginRight(6),
        xTicks(3),
        yTicks(3),
        xAxis(edgeBottom ? 'bottom' : null),
        yAxis(edgeLeft ? 'left' : null),
        xLabel(edgeBottom ? xCol : null),
        yLabel(edgeLeft ? yCol : null),
      ];
      let el: HTMLElement;
      if (row === colIndex) {
        el = plot(
          rectY(from(ctx.tableName, { filterBy: ctx.population }), { x: bin(xCol), y: count(), fill: BACKGROUND_FILL, inset: 0.5 }),
          rectY(from(ctx.tableName, { filterBy: ctx.brush }), { x: bin(xCol), y: count(), fill: ACCENT_FILL, inset: 0.5 }),
          intervalX({ as: ctx.brush, brush: BRUSH_STYLE }),
          ...common,
          yAxis(null),
          yLabel(null)
        );
      } else {
        const fg = from(ctx.tableName, { filterBy: ctx.brush });
        const marks = useRaster
          ? [raster(fg, { x: xCol, y: yCol, pixelSize: 2 })]
          : [
              dot(from(ctx.tableName, { filterBy: ctx.population }), { x: xCol, y: yCol, fill: BACKGROUND_FILL, r: 1.5 }),
              dot(fg, { x: xCol, y: yCol, fill: ACCENT_FILL, r: 1.5, fillOpacity: 0.8 }),
            ];
        el = plot(...marks, intervalXY({ as: ctx.brush, brush: BRUSH_STYLE }), ...common);
      }
      el.classList.add('splom-cell');
      plots.push(el);
      grid.appendChild(el);
    });
  });
  return { element: grid, plots };
}
