// vgplot（mosaic-plot 0.31.0）の raster マークの不具合への対処。
//
// 選択や絞り込みの結果が0行になると、raster マークは集計結果の列が無いまま
// 色の割り当て（rasterEncoding）に進み、"Cannot read properties of undefined
// (reading 'forEach')" で落ちる。落ちると画像が描き替わらず、直前の選択の
// 点がそのまま残って見えるため、「選んだ範囲に該当する行が無い」のに
// 何か選ばれているように誤読させてしまう。
// 散布図行列（点の総数が多いと raster になる）で、別のグラフとの選択が
// 重ならなかったときに実際に起きた。
//
// 0行のときだけ「画像なし」にして返し、それ以外は元の処理に任せる。
// ライブラリ側で直ったら、このファイルは消してよい。

import { RasterMark } from '@uwdata/mosaic-plot';

type RasterLike = { data: unknown; queryResult(data: unknown): unknown };
const proto = RasterMark.prototype as unknown as RasterLike;
const original = proto.queryResult;

proto.queryResult = function (this: RasterLike, data: unknown) {
  const rows = (data as { numRows?: number } | null)?.numRows ?? 0;
  if (rows === 0) {
    this.data = { numRows: 0, columns: { src: [] } };
    return this;
  }
  return original.call(this, data);
};
