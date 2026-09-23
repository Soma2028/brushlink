// チャート生成：散布図（軸選択・dot/raster自動切替）とヒストグラム。
// Python版 src/charts.py 相当。

import type { Coordinator } from '@uwdata/vgplot';
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
} from '@uwdata/vgplot';

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

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

/**
 * 数値列の中から、相関係数の絶対値が最も高い2列を選ぶ。
 * X/Y軸の初期値をユーザーに考えさせず自動生成するため（製品方針）。
 * 数値列がちょうど2つならそのまま返す。3つ以上ある場合は全ペアの
 * corr() を1クエリ（UNION ALL）にまとめて計算する。
 */
export async function pickBestAxisPair(
  db: Coordinator,
  tableName: string,
  numericCols: string[]
): Promise<[string, string]> {
  if (numericCols.length < 2) {
    throw new Error('数値列が2つ以上ないため軸を選べません。');
  }
  if (numericCols.length === 2) {
    return [numericCols[0], numericCols[1]];
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
        `SELECT ${idx} AS idx, abs(corr(${quoteIdent(a)}, ${quoteIdent(b)})) AS c FROM ${quoteIdent(tableName)}`
    )
    .join(' UNION ALL ');
  const result: any = await db.query(`${selects} ORDER BY c DESC NULLS LAST LIMIT 1`, {
    cache: false,
  });
  const rows = result.toArray();
  if (rows.length === 0) return [numericCols[0], numericCols[1]];
  return pairs[Number(rows[0].idx)];
}

export interface ScatterConfig {
  tableName: string;
  x: string;
  y: string;
  colorCol: string | null;
  rowCount: number;
  filterBy: Selection;
}

/**
 * 散布図側のマークを組み立てる。行数が DOT_TO_RASTER_THRESHOLD 以上なら
 * raster、未満なら dot。ユーザーに選ばせる UI は作らない。
 */
export function buildScatterPlot(cfg: ScatterConfig): HTMLElement {
  const source = from(cfg.tableName, { filterBy: cfg.filterBy });
  const useRaster = cfg.rowCount >= DOT_TO_RASTER_THRESHOLD;

  const mark = useRaster
    ? raster(source, { x: cfg.x, y: cfg.y })
    : dot(source, {
        x: cfg.x,
        y: cfg.y,
        ...(cfg.colorCol ? { fill: cfg.colorCol } : {}),
      });

  return plot(mark, intervalXY({ as: cfg.filterBy }), width(420), height(320));
}

export function buildHistogram(
  tableName: string,
  column: string,
  filterBy: Selection
): HTMLElement {
  return plot(
    rectY(from(tableName, { filterBy }), {
      x: bin(column),
      y: count(),
      fill: 'steelblue',
    }),
    intervalX({ as: filterBy }),
    width(420),
    height(200)
  );
}
