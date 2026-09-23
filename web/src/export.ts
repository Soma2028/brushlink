// 図の書き出し（CLAUDE.md「次にやること」5）。
//
// 画面に出ている散布図・ヒストグラム（選択範囲の強調やブラシの枠を含む）を、
// 1枚の図として SVG / PNG で保存する。CSV ではなく図を書き出すのは、
// 探索の結果を報告書やスライドにそのまま貼る用途を想定しているため。
//
// 図の上部には、何を・どの条件で選んだ図なのかを後から読み返せるよう、
// 軸・件数・フィルタ条件の注記を入れる（図だけ切り出すと、どの範囲を
// 選んだ状態の図なのかが分からなくなるため）。
//
// vgplot の各チャートはそれぞれ独立した <svg> なので、画面上の位置関係を
// そのまま保って1つの <svg> の中に並べ直す。PNG はその SVG をブラウザで
// 画像として描画し、canvas 経由で書き出す（外部ライブラリを使わない）。

import { escapeHtml } from './dom';

export interface FigureCaption {
  title: string;
  lines: string[];
}

const PADDING = 24;
const TITLE_SIZE = 16;
const LINE_SIZE = 12;
const LINE_GAP = 6;
const FONT = "system-ui, -apple-system, 'Hiragino Sans', 'Noto Sans JP', sans-serif";
// 凡例の見本色を拾う対象から外す、チャート本体とみなす svg の最小幅
const MIN_PLOT_WIDTH = 60;

function serializeSvg(svg: SVGSVGElement, x: number, y: number, width: number, height: number): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('x', String(x));
  clone.setAttribute('y', String(y));
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  return new XMLSerializer().serializeToString(clone);
}

/**
 * 凡例（vgplot の colorLegend）は HTML と小さな svg の組み合わせなので、
 * 見本色と文字を読み取って SVG の図形として描き直す。
 */
function legendSvg(container: HTMLElement, x: number, y: number): { svg: string } {
  const swatches = [...container.querySelectorAll<SVGSVGElement>('svg')].filter(
    (s) => s.getBoundingClientRect().width < MIN_PLOT_WIDTH
  );
  let cursor = x;
  const parts: string[] = [];
  for (const swatch of swatches) {
    const colored = swatch.querySelector('[fill]') ?? swatch;
    const fill = colored.getAttribute('fill') ?? getComputedStyle(colored).fill ?? '#999';
    const label = (swatch.parentElement?.textContent ?? '').trim();
    parts.push(`<rect x="${cursor}" y="${y}" width="12" height="12" rx="2" fill="${escapeHtml(fill)}"/>`);
    parts.push(`<text x="${cursor + 16}" y="${y + 10}" font-size="11" font-family="${FONT}" fill="#1c2330">${escapeHtml(label)}</text>`);
    cursor += 16 + label.length * 11 + 14;
  }
  return { svg: parts.join('') };
}

/**
 * 画面のチャート群を1枚の SVG 文字列に組み立てる。
 * 位置は画面上の配置（getBoundingClientRect）をそのまま使うので、
 * 画面で見ている並びと同じ図になる。
 */
export function composeFigure(plotsEl: HTMLElement, caption: FigureCaption): { svg: string; width: number; height: number } {
  const base = plotsEl.getBoundingClientRect();
  const captionHeight = TITLE_SIZE + LINE_GAP + caption.lines.length * (LINE_SIZE + LINE_GAP) + LINE_GAP;
  const top = PADDING + captionHeight;

  // 凡例も画面上と同じ位置に描き直す
  const legendEl = plotsEl.querySelector<HTMLElement>('.legend-wrap');
  const legendRect = legendEl?.getBoundingClientRect();
  const legend =
    legendEl && legendRect
      ? legendSvg(legendEl, PADDING + (legendRect.left - base.left), top + (legendRect.top - base.top) + 2)
      : { svg: '' };

  const plotSvgs = [...plotsEl.querySelectorAll<SVGSVGElement>('svg')].filter((s) => {
    // svg の中の svg（入れ子）と、凡例の見本色は除く
    if (s.parentElement?.closest('svg')) return false;
    return s.getBoundingClientRect().width >= MIN_PLOT_WIDTH;
  });

  let right = 0;
  let bottom = 0;
  const pieces = plotSvgs.map((svg) => {
    const r = svg.getBoundingClientRect();
    const x = PADDING + (r.left - base.left);
    const y = top + (r.top - base.top);
    right = Math.max(right, x + r.width);
    bottom = Math.max(bottom, y + r.height);
    return serializeSvg(svg, x, y, r.width, r.height);
  });

  const width = Math.ceil(Math.max(right, 480) + PADDING);
  const height = Math.ceil(bottom + PADDING);
  const title = `<text x="${PADDING}" y="${PADDING + TITLE_SIZE - 3}" font-size="${TITLE_SIZE}" font-weight="700" font-family="${FONT}" fill="#1c2330">${escapeHtml(caption.title)}</text>`;
  const lines = caption.lines
    .map(
      (line, i) =>
        `<text x="${PADDING}" y="${PADDING + TITLE_SIZE + LINE_GAP + (i + 1) * (LINE_SIZE + LINE_GAP) - 4}" font-size="${LINE_SIZE}" font-family="${FONT}" fill="#4b5363">${escapeHtml(line)}</text>`
    )
    .join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="#ffffff"/>
${title}${lines}${legend.svg}
${pieces.join('\n')}
</svg>`;
  return { svg, width, height };
}

function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // クリック直後に解放すると一部のブラウザで保存が始まらないため、少し待つ
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function timestampedName(ext: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `brushlink-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.${ext}`;
}

export function downloadSvg(figure: { svg: string }) {
  download(new Blob([figure.svg], { type: 'image/svg+xml;charset=utf-8' }), timestampedName('svg'));
}

/**
 * PNG で保存する。解像度は画面の2倍（スライドに貼っても粗くならないように）。
 */
export async function downloadPng(figure: { svg: string; width: number; height: number }, scale = 2) {
  const url = URL.createObjectURL(new Blob([figure.svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = figure.width * scale;
    canvas.height = figure.height * scale;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(scale, scale);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, figure.width, figure.height);
    ctx.drawImage(img, 0, 0, figure.width, figure.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('PNG の生成に失敗しました');
    download(blob, timestampedName('png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}
