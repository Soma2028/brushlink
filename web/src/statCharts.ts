// vgplot にマークの無い統計用のグラフ: 相関行列・Q-Q プロット・バイオリン図。
//
// 作り方はどれも同じ:
//   1. Mosaic のクライアント（makeClient）で、母集団（$filter）と選択中
//      （$selected）のそれぞれに対する集計を DuckDB に投げる。選択や絞り込みが
//      変わるたびに Mosaic が再集計してくるので、連動は Mosaic に任せられる
//   2. 集計結果（数百行以下）を Observable Plot で描く（vgplot も内部で使っている
//      描画ライブラリ。軸や目盛りを自前で描かずに済む）
//   3. グラフ上の操作（クリック・縦方向のドラッグ）を、vgplot の interactor と
//      同じ形の「節」（clausePoints / clauseInterval）にして $brush に書き込む
// 3 によって、自作のグラフで選んでも他のグラフ・統計量がすべて連動する。
//
// 集計の Selection は「ドラッグが止まってから追従する」ミラー（settle.ts）を
// 使う。分位点（並べ替え）や全ペアの相関は、ドラッグの1フレームごとに
// 計算し直すには重いため。

import * as Plot from '@observablehq/plot';
import { makeClient, clausePoints, clauseInterval } from '@uwdata/mosaic-core';
import type { Selection, MosaicClient } from '@uwdata/mosaic-core';
import { Query, count, avg, stddev, corr, sql, isNotNull, column } from '@uwdata/mosaic-sql';
import type { Coordinator } from '@uwdata/vgplot';
import jStat from 'jstat';
import { quoteIdent } from './sql';
import { escapeHtml } from './dom';

const GRAY = '#9aa3b2';
const GRAY_FILL = '#d4d8de';
const ACCENT = '#2563eb';

export interface StatChartContext {
  db: Coordinator;
  tableName: string;
  population: Selection; // 母集団（ドラッグが止まってから追従するミラー）
  selected: Selection; // 選択中（同上。intersect なので自分のグラフの選択も効く）
  brush: Selection; // 選択を書き込む先（$brush）
  hasSelection: () => boolean;
  width: number;
  height: number;
}

export interface StatChart {
  element: HTMLElement;
  clients: MosaicClient[];
  // このグラフが $brush に書き込んだ節かどうか（カードの削除時に解除するため）
  owns(source: unknown): boolean;
  resize(width: number): void;
}

/** Mosaic の述語（配列・単体・undefined）を where に渡せる配列にする。 */
function asList(filter: unknown): any[] {
  if (filter === undefined || filter === null) return [];
  return Array.isArray(filter) ? filter : [filter];
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Plot が返す図（svg、凡例付きなら figure）と、その中の目盛り（scale）の取り出し
type PlotFigure = (SVGSVGElement | HTMLElement) & { scale(name: string): any };

/** 図の本体の svg。凡例付きの figure では凡例の svg が先に来るので、最後の svg を取る。 */
function plotSvg(fig: PlotFigure): SVGSVGElement {
  if (fig.tagName.toLowerCase() === 'svg') return fig as SVGSVGElement;
  const all = fig.querySelectorAll(':scope > svg');
  return all[all.length - 1] as SVGSVGElement;
}

/**
 * ドラッグ中は描き直しを待たせるための印。自作のグラフは集計が届くたびに
 * 図（svg）ごと作り直すので、ドラッグの最中に作り直すと、押さえていた svg が
 * 消えてドラッグが失われる（別のグラフで選んだ直後に操作すると実際に起きた）。
 * ドラッグ中に届いた描き直しは、指を離したときにまとめて1回行う。
 */
class InteractionGate {
  active = false;
  private pending = false;
  /** 描き直してよければ true。ドラッグ中なら後回しにして false。 */
  allow(): boolean {
    if (this.active) this.pending = true;
    return !this.active;
  }
  end(render: () => void) {
    this.active = false;
    if (this.pending) {
      this.pending = false;
      render();
    }
  }
}

/**
 * 縦方向のドラッグとクリックを受ける。ドラッグなら onRange(値の下限, 上限)、
 * 4px 未満しか動かなければクリックとして onClick(x 座標, y 座標, shift)。
 * ドラッグ中の範囲は半透明の帯で見せる（vgplot のブラシと同じ見た目）。
 */
function attachVerticalBrush(
  fig: PlotFigure,
  gate: InteractionGate,
  render: () => void,
  onRange: (lo: number, hi: number) => void,
  onClick: (px: number, py: number, shift: boolean) => void
) {
  const svg = plotSvg(fig);
  const y = fig.scale('y');
  const [top, bottom] = [Math.min(...y.range), Math.max(...y.range)];
  const band = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  band.setAttribute('fill', ACCENT);
  band.setAttribute('fill-opacity', '0.08');
  band.setAttribute('stroke', ACCENT);
  band.setAttribute('stroke-width', '1.5');
  band.setAttribute('pointer-events', 'none');
  band.setAttribute('visibility', 'hidden');
  svg.appendChild(band);

  const local = (e: PointerEvent) => {
    const r = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const sx = vb && vb.width ? vb.width / r.width : 1;
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sx };
  };
  let start: { x: number; y: number } | null = null;
  const clampY = (v: number) => Math.max(top, Math.min(bottom, v));
  const drawBand = (y0: number, y1: number) => {
    const w = Number(svg.getAttribute('width')) || svg.viewBox.baseVal.width;
    band.setAttribute('x', '0');
    band.setAttribute('width', String(w));
    band.setAttribute('y', String(Math.min(y0, y1)));
    band.setAttribute('height', String(Math.abs(y1 - y0)));
    band.setAttribute('visibility', 'visible');
  };

  svg.style.cursor = 'crosshair';
  svg.addEventListener('pointerdown', (e) => {
    start = local(e);
    gate.active = true;
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', (e) => {
    if (!start) return;
    const p = local(e);
    if (Math.abs(p.y - start.y) >= 4) drawBand(clampY(start.y), clampY(p.y));
  });
  svg.addEventListener('pointerup', (e) => {
    if (!start) return;
    const p = local(e);
    const s = start;
    start = null;
    if (Math.abs(p.y - s.y) < 4) {
      band.setAttribute('visibility', 'hidden');
      onClick(p.x, p.y, e.shiftKey || e.metaKey);
    } else {
      const a = y.invert(clampY(s.y));
      const b = y.invert(clampY(p.y));
      onRange(Math.min(a, b), Math.max(a, b));
    }
    gate.end(render);
  });
  return {
    showRange(lo: number, hi: number) {
      drawBand(y.apply(hi), y.apply(lo));
    },
    hideRange() {
      band.setAttribute('visibility', 'hidden');
    },
  };
}

/**
 * $brush に書き込む節の出どころ（source）。vgplot の interactor と同じ形にして
 * おくと、画面の他の部分（選択のチップ表示・Esc での解除・カード削除時の解除）が
 * そのまま扱える: 範囲は field、クリックで選んだカテゴリは fields を持つ。
 */
class RangeSource {
  value: [number, number] | undefined;
  field: string;
  private onReset: () => void;
  constructor(field: string, onReset: () => void) {
    this.field = field;
    this.onReset = onReset;
  }
  reset() {
    this.value = undefined;
    this.onReset();
  }
}

class PointSource {
  value: unknown[][] | null = null;
  fields: string[];
  private onReset: () => void;
  constructor(field: string, onReset: () => void) {
    this.fields = [field];
    this.onReset = onReset;
  }
  reset() {
    this.value = null;
    this.onReset();
  }
}

function publishRange(brush: Selection, src: RangeSource, range: [number, number] | null) {
  src.value = range ?? undefined;
  brush.update(clauseInterval(column(src.field), range ?? undefined, { source: src as any, clients: new Set() }));
}

function publishPoints(brush: Selection, src: PointSource, values: unknown[] | null) {
  src.value = values && values.length ? values.map((v) => [v]) : null;
  brush.update(clausePoints([column(src.fields[0])], src.value ?? undefined, { source: src as any, clients: new Set() }));
}

// ---------------------------------------------------------------------------
// 相関行列
// ---------------------------------------------------------------------------

// 相関行列に並べる列の上限。15列で 15×15 のセルになり、カードの幅では
// これ以上並べるとセル内の数値が読めない
const MAX_CORR_COLUMNS = 15;

/**
 * 相関行列のヒートマップ。選択中の行（選択が無ければ母集団）で全ペアの
 * 相関係数を1クエリで計算する。セルをクリックすると onPick(X列, Y列) を呼ぶ
 * （画面側で散布図の軸をその2列に切り替える）。
 */
export function buildCorrHeatmap(
  columns: string[],
  ctx: StatChartContext,
  onPick: (x: string, y: string) => void
): StatChart {
  const cols = columns.slice(0, MAX_CORR_COLUMNS);
  const element = document.createElement('div');
  element.className = 'stat-chart';
  let width = ctx.width;
  let latest: { a: string; b: string; r: number | null }[] | null = null;
  let rows = 0;

  const render = () => {
    if (!latest) return;
    const note =
      (ctx.hasSelection() ? `選択中 ${rows.toLocaleString()} 件の相関` : `母集団 ${rows.toLocaleString()} 件の相関`) +
      (columns.length > cols.length ? `（数値列が多いため先頭 ${cols.length} 列）` : '');
    const size = Math.min(width, 120 + cols.length * 56);
    const fig = Plot.plot({
      width: size,
      height: size - 40,
      marginLeft: 90,
      marginBottom: 80,
      x: { domain: cols, tickRotate: -35, label: null },
      y: { domain: cols, label: null },
      color: { type: 'linear', scheme: 'RdBu', domain: [-1, 1], legend: true, label: '相関係数 r' },
      marks: [
        Plot.cell(latest, { x: 'a', y: 'b', fill: (d: any) => d.r ?? 0, inset: 0.5, stroke: 'white' }),
        Plot.text(latest, {
          x: 'a',
          y: 'b',
          text: (d: any) => (d.r === null ? '—' : d.r.toFixed(2)),
          fill: (d: any) => (d.r !== null && Math.abs(d.r) > 0.6 ? 'white' : '#1c2330'),
          fontSize: 10,
          // 数値の文字がセルの上に重なってクリックを奪わないように
          pointerEvents: 'none',
        }),
      ],
    }) as PlotFigure;
    // セルは描いた順（= latest の順）に並ぶので、番号で元のペアを引く。
    // 凡例付きの図は figure で、最初の svg は凡例なので、図全体から探す
    const cells = fig.querySelectorAll('g[aria-label="cell"] rect');
    cells.forEach((rect, i) => {
      const d = latest![i];
      if (!d || d.a === d.b) return;
      rect.setAttribute('style', 'cursor:pointer');
      rect.addEventListener('click', () => onPick(d.a, d.b));
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `${d.a} × ${d.b}: r = ${d.r === null ? '—' : d.r.toFixed(3)}（クリックで散布図に）`;
      rect.appendChild(title);
    });
    element.innerHTML = `<p class="stat-note">${escapeHtml(note)}</p>`;
    element.appendChild(fig);
  };

  const client = makeClient({
    coordinator: ctx.db,
    filterStable: false,
    selection: ctx.selected,
    query: (filter) => {
      const select: Record<string, any> = { __n: count() };
      cols.forEach((a, i) =>
        cols.forEach((b, j) => {
          if (j > i) select[`r_${i}_${j}`] = corr(a, b);
        })
      );
      return Query.from(ctx.tableName).select(select).where(filter);
    },
    queryResult: (data: any) => {
      const row = data.get(0);
      rows = Number(row.__n);
      latest = [];
      cols.forEach((a, i) =>
        cols.forEach((b, j) => {
          const r = i === j ? 1 : toNumber(row[`r_${Math.min(i, j)}_${Math.max(i, j)}`]);
          latest!.push({ a, b, r });
        })
      );
      render();
    },
  });

  return {
    element,
    clients: [client],
    owns: () => false,
    resize(w) {
      width = w;
      render();
    },
  };
}

// ---------------------------------------------------------------------------
// Q-Q プロット
// ---------------------------------------------------------------------------

// 分位点の数。行数によらず点の数を一定にし、100万行でも描画の重さが変わらない
// ようにする（全行を点にすると、散布図の dot と同じく行数に比例して重くなる）
const QQ_POINTS = 100;

interface QQSeries {
  points: { z: number; q: number }[];
  mean: number | null;
  sd: number | null;
  n: number;
}

/**
 * Q-Q プロット（正規分布との比較）。横軸が正規分布の理論分位点、縦軸が
 * データの分位点。点が斜めの参照線（平均 + SD × 理論値）に沿うほど正規分布に近い。
 * 分位点は DuckDB の quantile_cont で QQ_POINTS 個だけ求め、理論分位点は
 * jStat の正規分布の逆関数で求める。
 * 縦軸はデータの値なので、縦にドラッグすると「値の範囲」として $brush に入る。
 */
export function buildQQ(column_: string, ctx: StatChartContext): StatChart {
  const element = document.createElement('div');
  element.className = 'stat-chart';
  let width = ctx.width;
  const probs = Array.from({ length: QQ_POINTS }, (_, i) => (i + 0.5) / QQ_POINTS);
  const theo = probs.map((p) => jStat.normal.inv(p, 0, 1));
  let pop: QQSeries | null = null;
  let sel: QQSeries | null = null;
  const range = new RangeSource(column_, () => brushView?.hideRange());
  let brushView: ReturnType<typeof attachVerticalBrush> | null = null;
  const gate = new InteractionGate();

  const query = (filter: unknown) =>
    Query.from(ctx.tableName)
      .select({
        q: sql`quantile_cont(${column(column_)}, [${sql`${probs.join(', ')}`}])`,
        n: count(column_),
        mean: avg(column_),
        sd: stddev(column_),
      })
      .where(...asList(filter), isNotNull(column_));
  const parse = (data: any): QQSeries => {
    const row = data.get(0);
    const q = row.q ? Array.from(row.q as ArrayLike<unknown>).map(Number) : [];
    return {
      points: q.length ? theo.map((z, i) => ({ z, q: q[i] })) : [],
      mean: toNumber(row.mean),
      sd: toNumber(row.sd),
      n: Number(row.n),
    };
  };

  const render = () => {
    if (!pop || !gate.allow()) return;
    const marks: any[] = [];
    const refLine = (s: QQSeries, stroke: string, dash: string) =>
      s.mean !== null && s.sd !== null
        ? Plot.line(
            [
              { z: theo[0], q: s.mean + s.sd * theo[0] },
              { z: theo[theo.length - 1], q: s.mean + s.sd * theo[theo.length - 1] },
            ],
            { x: 'z', y: 'q', stroke, strokeDasharray: dash, strokeWidth: 1.5 }
          )
        : null;
    marks.push(refLine(pop, GRAY, '5 3'), Plot.dot(pop.points, { x: 'z', y: 'q', fill: GRAY_FILL, stroke: GRAY, r: 2.5 }));
    if (sel && ctx.hasSelection() && sel.points.length) {
      marks.push(refLine(sel, ACCENT, '3 3'), Plot.dot(sel.points, { x: 'z', y: 'q', fill: ACCENT, r: 2.5 }));
    }
    const fig = Plot.plot({
      width,
      height: 280,
      marginLeft: 50,
      x: { label: '正規分布の理論分位点 →' },
      y: { label: `↑ ${column_}（データの分位点）`, grid: true },
      marks: marks.filter(Boolean),
    }) as PlotFigure;
    brushView = attachVerticalBrush(
      fig,
      gate,
      render,
      (lo, hi) => publishRange(ctx.brush, range, [lo, hi]),
      () => publishRange(ctx.brush, range, null)
    );
    if (range.value) brushView.showRange(range.value[0], range.value[1]);
    const note = `母集団 ${pop.n.toLocaleString()} 件${sel && ctx.hasSelection() ? `・選択中 ${sel.n.toLocaleString()} 件` : ''}（${QQ_POINTS} 個の分位点）`;
    element.innerHTML = `<p class="stat-note">${escapeHtml(note)}</p>`;
    element.appendChild(fig);
  };

  const clients = [
    makeClient({
      coordinator: ctx.db,
      filterStable: false,
      selection: ctx.population,
      query,
      queryResult: (data) => {
        pop = parse(data);
        render();
      },
    }),
    makeClient({
      coordinator: ctx.db,
      filterStable: false,
      selection: ctx.selected,
      query,
      queryResult: (data) => {
        sel = parse(data);
        render();
      },
    }),
  ];

  return {
    element,
    clients,
    owns: (source) => source === range,
    resize(w) {
      width = w;
      render();
    },
  };
}

// ---------------------------------------------------------------------------
// バイオリン図
// ---------------------------------------------------------------------------

// 分布を数えるビンの数。KDE（カーネル密度推定）の前段として、DuckDB 側で
// カテゴリ × ビンの件数だけを数える（行データを JS に持ってこない）
const VIOLIN_BINS = 48;

/**
 * ビンの件数をガウスカーネルでなめらかにする。帯域幅は Silverman の目安
 * （0.9 × min(SD, IQR/1.34) × n^(-1/5)）を、ビンの件数から近似した SD と
 * 四分位範囲で求める。ビンの件数からの近似なので厳密な KDE ではないが、
 * 形を見る用途には十分。
 */
function smooth(counts: number[], sigmaBins?: number): { values: number[]; sigmaBins: number } {
  const n = counts.reduce((s, v) => s + v, 0);
  let sigma = sigmaBins;
  if (sigma === undefined) {
    if (n < 2) sigma = 1;
    else {
      const mean = counts.reduce((s, c, i) => s + c * i, 0) / n;
      const sd = Math.sqrt(counts.reduce((s, c, i) => s + c * (i - mean) ** 2, 0) / (n - 1));
      let acc = 0;
      let q1 = 0;
      let q3 = 0;
      counts.forEach((c, i) => {
        if (acc < n * 0.25 && acc + c >= n * 0.25) q1 = i;
        if (acc < n * 0.75 && acc + c >= n * 0.75) q3 = i;
        acc += c;
      });
      const spread = Math.min(sd, (q3 - q1) / 1.34 || sd);
      sigma = Math.max(0.8, 0.9 * spread * n ** -0.2);
    }
  }
  const values = counts.map((_, i) => {
    let s = 0;
    counts.forEach((c, j) => {
      if (c) s += c * Math.exp(-0.5 * ((i - j) / sigma!) ** 2);
    });
    return s;
  });
  return { values, sigmaBins: sigma };
}

/**
 * バイオリン図（カテゴリ × 数値）。カテゴリごとに値の分布を左右対称の形で描く。
 * 灰色が母集団、青が選択中。幅は件数に比例させている（選択中は母集団の中に
 * 収まって見える。カテゴリ間でも件数の多さが幅で比べられる）。
 * クリックでカテゴリを、縦のドラッグで値の範囲を選び、どちらも $brush に入る。
 */
export async function buildViolin(
  category: string,
  value: string,
  categories: unknown[],
  ctx: StatChartContext
): Promise<StatChart> {
  const element = document.createElement('div');
  element.className = 'stat-chart';
  let width = ctx.width;
  const cats = categories.filter((v) => v !== null && v !== undefined);
  const ext: any = (
    await ctx.db.query(
      `SELECT min(${quoteIdent(value)}) AS lo, max(${quoteIdent(value)}) AS hi FROM ${quoteIdent(ctx.tableName)}`,
      { cache: false }
    )
  ).get(0);
  const lo = Number(ext.lo);
  const hi = Number(ext.hi);
  const binWidth = hi > lo ? (hi - lo) / VIOLIN_BINS : 1;
  const binExpr = sql`least(greatest(floor((${column(value)} - ${lo}) / ${binWidth}), 0), ${VIOLIN_BINS - 1})`;

  type Grid = Map<string, number[]>;
  let pop: Grid | null = null;
  let sel: Grid | null = null;
  const rangeSrc = new RangeSource(value, () => brushView?.hideRange());
  const pointSrc = new PointSource(category, () => render());
  let brushView: ReturnType<typeof attachVerticalBrush> | null = null;
  const gate = new InteractionGate();

  const query = (filter: unknown) =>
    Query.from(ctx.tableName)
      .select({ c: sql`CAST(${column(category)} AS VARCHAR)`, b: binExpr, n: count() })
      .where(...asList(filter), isNotNull(value), isNotNull(category))
      .groupby(column(category), binExpr);
  const parse = (data: any): Grid => {
    const grid: Grid = new Map(cats.map((c) => [String(c), new Array(VIOLIN_BINS).fill(0)]));
    for (const r of data.toArray()) {
      const arr = grid.get(String(r.c));
      if (arr) arr[Number(r.b)] = Number(r.n);
    }
    return grid;
  };

  const render = () => {
    if (!pop || !gate.allow()) return;
    const shapes: { cat: number; y: number; x1: number; x2: number; layer: string }[] = [];
    const medians: { cat: number; y: number }[] = [];
    const smoothed = cats.map((c) => smooth(pop!.get(String(c))!));
    // 幅の基準: 全カテゴリの母集団の密度（件数）の最大値
    const maxDensity = Math.max(1e-9, ...smoothed.flatMap((s) => s.values));
    const HALF = 0.42;
    const picked = new Set((pointSrc.value ?? []).map((p) => String(p[0])));
    cats.forEach((c, i) => {
      const popS = smoothed[i];
      const counts = pop!.get(String(c))!;
      popS.values.forEach((d, b) => {
        const w = (d / maxDensity) * HALF;
        shapes.push({ cat: i, y: lo + (b + 0.5) * binWidth, x1: i - w, x2: i + w, layer: 'pop' });
      });
      // 中央値（ビンの件数からの近似）
      const n = counts.reduce((s, v) => s + v, 0);
      let acc = 0;
      const mb = counts.findIndex((v) => (acc += v) >= n / 2);
      if (n > 0) medians.push({ cat: i, y: lo + (mb + 0.5) * binWidth });
      if (sel && ctx.hasSelection()) {
        const selS = smooth(sel.get(String(c))!, popS.sigmaBins);
        selS.values.forEach((d, b) => {
          const w = (d / maxDensity) * HALF;
          shapes.push({ cat: i, y: lo + (b + 0.5) * binWidth, x1: i - w, x2: i + w, layer: 'sel' });
        });
      }
    });
    const fig = Plot.plot({
      width,
      height: 300,
      marginLeft: 50,
      x: {
        domain: [-0.5, cats.length - 0.5],
        ticks: cats.map((_, i) => i),
        tickFormat: (i: number) => String(cats[i] ?? ''),
        label: null,
      },
      y: { label: `↑ ${value}`, grid: true },
      marks: [
        Plot.areaX(
          shapes.filter((s) => s.layer === 'pop'),
          {
            y: 'y',
            x1: 'x1',
            x2: 'x2',
            z: 'cat',
            fill: (d: any) => (picked.size && !picked.has(String(cats[d.cat])) ? '#eceef2' : GRAY_FILL),
            stroke: GRAY,
            strokeWidth: 0.8,
            curve: 'basis',
          }
        ),
        Plot.areaX(
          shapes.filter((s) => s.layer === 'sel'),
          { y: 'y', x1: 'x1', x2: 'x2', z: 'cat', fill: ACCENT, fillOpacity: 0.75, curve: 'basis' }
        ),
        // 中央値の短い横線。横軸は数値（カテゴリの番号）なので、tickY（横軸が
        // カテゴリの目盛り前提）ではなく x1〜x2 を数値で与える ruleY で描く
        Plot.ruleY(medians, { y: 'y', x1: (d: any) => d.cat - 0.16, x2: (d: any) => d.cat + 0.16, stroke: '#1c2330', strokeWidth: 2 }),
      ],
    }) as PlotFigure;
    const x = fig.scale('x');
    brushView = attachVerticalBrush(
      fig,
      gate,
      render,
      (a, b) => publishRange(ctx.brush, rangeSrc, [a, b]),
      (px, _py, shift) => {
        const i = Math.round(x.invert(px));
        const cat = cats[i];
        if (cat === undefined) {
          publishPoints(ctx.brush, pointSrc, null);
          return;
        }
        // 同じカテゴリを単独で選んでいるときはもう一度のクリックで解除、
        // Shift を押しながらなら追加・除外（棒グラフの toggle と同じ操作）
        const current = (pointSrc.value ?? []).map((p) => p[0]);
        let next: unknown[];
        if (shift) next = current.includes(cat) ? current.filter((v) => v !== cat) : [...current, cat];
        else next = current.length === 1 && current[0] === cat ? [] : [cat];
        publishPoints(ctx.brush, pointSrc, next);
        render();
      }
    );
    if (rangeSrc.value) brushView.showRange(rangeSrc.value[0], rangeSrc.value[1]);
    element.replaceChildren(fig);
  };

  const clients = [
    makeClient({
      coordinator: ctx.db,
      filterStable: false,
      selection: ctx.population,
      query,
      queryResult: (data) => {
        pop = parse(data);
        render();
      },
    }),
    makeClient({
      coordinator: ctx.db,
      filterStable: false,
      selection: ctx.selected,
      query,
      queryResult: (data) => {
        sel = parse(data);
        render();
      },
    }),
  ];

  return {
    element,
    clients,
    owns: (source) => source === rangeSrc || source === pointSrc,
    resize(w) {
      width = w;
      render();
    },
  };
}
