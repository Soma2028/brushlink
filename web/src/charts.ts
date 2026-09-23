// チャート生成：散布図（軸選択・dot/raster自動切替）とヒストグラム。
// Python版 src/charts.py 相当。

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
} from '@uwdata/vgplot';


// dot と raster の自動切替閾値。ユーザーには選ばせず、行数から自動判定する
// （CLAUDE.md「決まっていること」）。
//
// 根拠: docs/performance.md の計測。dot は10万行でドラッグ応答518ms、
// 100万行で6,822ms と行数に対して非線形に悪化する一方、raster は
// 1万〜100万行を通じて157〜158msでほぼ一定。10万行の時点で体感できる
// 遅延（500ms超）が生じ始めるため、そこから十分小さい側に倒して
// 50,000 を閾値にした。1万〜10万の間そのものは計測しておらず、
// 50,000 という数値自体は計測で直接確認した境界ではなく、既知の安全域
// （1万）と既知の危険域（10万）の間の暫定値である
// （docs/performance.md「まだ分かっていないこと」参照）。
export const DOT_TO_RASTER_THRESHOLD = 50_000;

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

export interface ScatterConfig {
  tableName: string;
  x: string;
  y: string;
  colorCol: string | null;
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
