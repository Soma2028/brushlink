// グラフを複数並べる領域。1枚ずつ「カード」として追加・削除・設定変更できる。
//
// 各カードは自分のグラフ（vgplot の plot）と回帰の集計クライアントだけを
// 管理する。設定を変えたり削除したりしても作り直すのはそのカードだけで、
// 他のグラフの選択（ブラシ）はそのまま残る。
//
// 列の選び方: 先に X・Y の列を選び、その型の組み合わせで描けるグラフだけを
// 「種類」の選択肢に出す（chartTypes.ts）。Y に選べる列も X の型で絞る。

import type { Coordinator } from '@uwdata/vgplot';
import type { Selection, SelectionClause } from '@uwdata/mosaic-core';
import {
  availableTypes,
  yOptions,
  xOptions,
  kindOf,
  CHART_LABELS,
  CHART_HINTS,
} from './chartTypes';
import type { ChartConfig, ChartType, ColumnKinds } from './chartTypes';
import {
  buildScatterPlot,
  buildHistogram,
  buildBarCount,
  buildBarMean,
  buildErrorBar,
  buildLine,
  buildColorLegend,
  DOT_TO_RASTER_THRESHOLD,
} from './charts';
import { connectRegressionClients, renderRegression } from './regression';
import type { RegressionResult } from './regression';
import { escapeHtml } from './dom';

export interface GridContext {
  db: Coordinator;
  tableName: string;
  rowCount: number;
  population: Selection; // $filter
  brush: Selection; // $brush（crossfilter）
  selected: Selection; // 散布図の回帰直線・回帰の集計用（ドラッグが止まってから追従）
  selectedLive: Selection; // $selected（即時）。カテゴリのグラフの色付きの層に使う
  populationSettled: Selection;
  getKinds: () => ColumnKinds;
  categoryValues: (column: string) => Promise<unknown[]>;
  hasSelection: () => boolean;
}

// vgplot の plot 要素。value に Plot オブジェクトを持つ（mosaic-plot の仕様）
type PlotObject = {
  marks: { coordinator: unknown }[];
  setAttribute(name: string, value: unknown): boolean;
  render(): Promise<void>;
};
type PlotElement = HTMLElement & { value?: PlotObject };

// 散布図の名前に付ける連番（凡例は名前で散布図を引くので、一意にする）
let plotSerial = 0;

const CHART_HEIGHT: Record<ChartType, number> = {
  scatter: 340,
  histogram: 240,
  'bar-count': 260,
  'bar-mean': 260,
  errorbar: 280,
  line: 260,
};

function option(value: string, label: string, selected: boolean): string {
  return `<option value="${escapeHtml(value)}" ${selected ? 'selected' : ''}>${escapeHtml(label)}</option>`;
}

class ChartCard {
  readonly element: HTMLElement;
  private body: HTMLElement;
  private regressionEl: HTMLElement;
  private plotEl: PlotElement | null = null;
  private extraClients: unknown[] = [];
  private regression: { sel: RegressionResult | null; pop: RegressionResult | null } = { sel: null, pop: null };
  private lastWidth = 0;
  private buildSerial = 0;

  config: ChartConfig;
  private ctx: GridContext;
  private onRemove: (card: ChartCard) => void;

  constructor(config: ChartConfig, ctx: GridContext, onRemove: (card: ChartCard) => void) {
    this.config = config;
    this.ctx = ctx;
    this.onRemove = onRemove;
    this.element = document.createElement('article');
    this.element.className = 'chart-card';
    this.element.innerHTML = `
      <header class="chart-head">
        <div class="chart-controls"></div>
        <button type="button" class="icon-button" data-role="remove" aria-label="このグラフを削除" title="このグラフを削除">×</button>
      </header>
      <div class="chart-title" data-chart-title></div>
      <div class="chart-body"></div>
      <div class="chart-regression regression"></div>`;
    this.body = this.element.querySelector('.chart-body')!;
    this.regressionEl = this.element.querySelector('.chart-regression')!;
    this.element.querySelector('[data-role="remove"]')!.addEventListener('click', () => this.onRemove(this));
  }

  get useRaster(): boolean {
    return this.ctx.rowCount >= DOT_TO_RASTER_THRESHOLD;
  }

  /**
   * 設定の選択肢を描き直す。X → Y → 種類 の順に、前の選択で意味をなす
   * ものだけを並べる。今の設定が選べなくなっていたら、選べる既定値に直す。
   */
  private renderControls() {
    const kinds = this.ctx.getKinds();
    const c = this.config;
    const xs = xOptions(kinds);
    if (!xs.includes(c.x)) c.x = xs[0];
    const ys = yOptions(kinds, c.x);
    if (c.y !== null && !ys.columns.includes(c.y)) c.y = ys.allowNone ? null : (ys.columns[0] ?? null);
    if (c.y === null && !ys.allowNone) c.y = ys.columns[0] ?? null;
    const types = availableTypes(kinds, c.x, c.y);
    if (!types.includes(c.type) && types.length > 0) c.type = types[0];

    const kindLabel = { numeric: '数値', category: 'カテゴリ', temporal: '日付', none: '' };
    const xGroup = (label: string, cols: string[]) =>
      cols.length ? `<optgroup label="${label}">${cols.map((col) => option(col, col, col === c.x)).join('')}</optgroup>` : '';
    const controls: string[] = [
      `<label>X <select data-role="x">${xGroup(kindLabel.numeric, kinds.numeric)}${xGroup(kindLabel.category, kinds.category)}${xGroup(kindLabel.temporal, kinds.temporal)}</select></label>`,
      `<label>Y <select data-role="y">${ys.allowNone ? option('', '（なし）', c.y === null) : ''}${ys.columns
        .map((col) => option(col, col, col === c.y))
        .join('')}</select></label>`,
      types.length
        ? `<label>種類 <select data-role="type">${types.map((t) => option(t, CHART_LABELS[t], t === c.type)).join('')}</select></label>`
        : '',
    ];
    if (c.type === 'scatter' && types.includes('scatter')) {
      const colors = kinds.category;
      controls.push(
        `<label>色 <select data-role="color" ${this.useRaster ? 'disabled title="行数が多いため密度表示になり、色分けできません"' : ''}>${option('', '（なし）', !c.color)}${colors
          .map((col) => option(col, col, col === c.color))
          .join('')}</select></label>`,
        `<label class="inline-check"><input type="checkbox" data-role="regression" ${c.regression ? 'checked' : ''}> 回帰直線</label>`
      );
    }
    if (c.type === 'errorbar' && types.includes('errorbar')) {
      controls.push(
        `<label>誤差 <select data-role="error">${option('se', '標準誤差（SE）', c.error === 'se')}${option('sd', '標準偏差（SD）', c.error === 'sd')}</select></label>`
      );
    }
    const box = this.element.querySelector('.chart-controls')!;
    box.innerHTML = controls.join('');

    const bind = (role: string, apply: (el: HTMLSelectElement & HTMLInputElement) => void) => {
      const el = box.querySelector<HTMLSelectElement & HTMLInputElement>(`[data-role="${role}"]`);
      el?.addEventListener('change', () => {
        apply(el);
        this.rebuild();
      });
    };
    bind('x', (el) => {
      c.x = el.value;
      // X の型が変わったら、種類は新しい組み合わせの既定に戻す
      c.type = availableTypes(kinds, c.x, c.y)[0] ?? c.type;
    });
    bind('y', (el) => {
      c.y = el.value || null;
      c.type = availableTypes(kinds, c.x, c.y)[0] ?? c.type;
    });
    bind('type', (el) => (c.type = el.value as ChartType));
    bind('color', (el) => (c.color = el.value || null));
    bind('regression', (el) => (c.regression = el.checked));
    bind('error', (el) => (c.error = el.value as 'se' | 'sd'));
  }

  private titleText(): string {
    const c = this.config;
    const cols = c.y ? `${c.x} × ${c.y}` : c.x;
    return `${CHART_LABELS[c.type]} — ${cols}`;
  }

  /**
   * このカードのグラフだけを作り直す。古いグラフの選択（ブラシ・クリック）を
   * 解除してから切断する。軸が変わると古い範囲は新しいグラフの上に描けず、
   * 残すと「見えない選択」が他のグラフと統計量に効き続けてしまうため。
   */
  async rebuild() {
    const serial = ++this.buildSerial;
    this.dispose();
    this.renderControls();
    const c = this.config;
    const kinds = this.ctx.getKinds();
    const types = availableTypes(kinds, c.x, c.y);
    this.element.querySelector('[data-chart-title]')!.textContent = this.titleText();
    this.element.dataset.type = c.type;

    if (!types.includes(c.type)) {
      this.body.innerHTML = `<p class="chart-empty">${
        kindOf(kinds, c.x) === 'temporal'
          ? '日付の列を横軸にするときは、Y に数値の列を選んでください。'
          : 'この列の組み合わせで描けるグラフはありません。'
      }</p>`;
      return;
    }

    const needCategories = c.type === 'bar-count' || c.type === 'bar-mean' || c.type === 'errorbar';
    const categories = needCategories ? await this.ctx.categoryValues(c.x) : [];
    const colorValues = c.type === 'scatter' && c.color && !this.useRaster ? await this.ctx.categoryValues(c.color) : null;
    // 取得を待つ間に別の設定変更が来ていたら、古い組み立ては捨てる
    if (serial !== this.buildSerial) return;

    const size = { width: Math.max(this.body.clientWidth, 280), height: CHART_HEIGHT[c.type] };
    this.lastWidth = size.width;
    const { tableName, population, brush } = this.ctx;
    const catCtx = { tableName, population, brush, selected: this.ctx.selectedLive, categories, size };

    let plotEl: PlotElement;
    let legend: HTMLElement | null = null;
    switch (c.type) {
      case 'scatter': {
        const plotName = `scatter-${++plotSerial}`;
        plotEl = buildScatterPlot({
          tableName,
          x: c.x,
          y: c.y!,
          colorCol: this.useRaster ? null : c.color,
          colorValues,
          rowCount: this.ctx.rowCount,
          population,
          brush,
          selected: this.ctx.selected,
          showRegression: c.regression,
          plotName,
          width: size.width,
          height: size.height,
        });
        if (c.color && !this.useRaster) legend = buildColorLegend(plotName);
        break;
      }
      case 'histogram':
        plotEl = buildHistogram(tableName, c.x, population, brush, size);
        break;
      case 'bar-count':
        plotEl = buildBarCount(c.x, catCtx);
        break;
      case 'bar-mean':
        plotEl = buildBarMean(c.x, c.y!, catCtx);
        break;
      case 'errorbar':
        plotEl = buildErrorBar(c.x, c.y!, c.error, catCtx);
        break;
      case 'line':
        plotEl = buildLine(c.x, c.y!, { tableName, population, brush, size });
        break;
    }
    this.plotEl = plotEl;
    this.body.replaceChildren();
    if (legend) {
      const wrap = document.createElement('div');
      wrap.className = 'legend-wrap';
      wrap.appendChild(legend);
      this.body.appendChild(wrap);
    }
    this.body.appendChild(plotEl);
    this.element.querySelector('.chart-hint')?.remove();
    const hint = document.createElement('p');
    hint.className = 'chart-hint';
    hint.textContent =
      CHART_HINTS[c.type] +
      (c.type === 'scatter' && this.useRaster ? '（密度表示のため、選択外の灰色の点は表示されません）' : '');
    this.body.before(hint);

    if (c.type === 'scatter' && c.regression) {
      this.extraClients = [
        ...(connectRegressionClients(
          this.ctx.db,
          tableName,
          c.x,
          c.y!,
          this.ctx.populationSettled,
          this.ctx.selected,
          (sel, pop) => {
            this.regression = { sel, pop };
            this.renderRegression();
          }
        ) ?? []),
      ];
    } else {
      this.regressionEl.innerHTML = '';
    }
  }

  renderRegression() {
    const { sel, pop } = this.regression;
    if (!sel || !pop || this.config.type !== 'scatter' || !this.config.regression) return;
    renderRegression(this.regressionEl, this.config.x, this.config.y!, sel, pop, this.ctx.hasSelection());
  }

  /** このカードのグラフが作った選択の節（ブラシ・クリック）。 */
  ownClauses(): SelectionClause[] {
    const plot = this.plotEl?.value;
    if (!plot) return [];
    return this.ctx.brush.clauses.filter(
      (cl) => (cl.source as { mark?: { plot?: unknown } } | undefined)?.mark?.plot === plot
    );
  }

  /** グラフを切断して片付ける（選択の解除・集計クライアントの切断）。 */
  dispose() {
    const plot = this.plotEl?.value;
    const clauses = this.ownClauses();
    if (clauses.length) {
      for (const cl of clauses) {
        // クリック選択（toggle）には reset が無く、内部に選んだ値を覚えている。
        // 残ると次のクリックが「解除」と解釈されるので、ここで忘れさせる
        const src = cl.source as { value?: unknown };
        if ('value' in src) src.value = null;
      }
      this.ctx.brush.reset(clauses);
    }
    if (plot) {
      for (const m of plot.marks) if (m.coordinator) this.ctx.db.disconnect(m as any);
    }
    for (const client of this.extraClients) this.ctx.db.disconnect(client as any);
    this.extraClients = [];
    this.plotEl = null;
    this.regression = { sel: null, pop: null };
  }

  /** 幅だけが変わったとき、作り直さずに描き直す（選択を保つため）。 */
  resize() {
    const plot = this.plotEl?.value;
    if (!plot) return;
    const width = Math.max(this.body.clientWidth, 280);
    if (Math.abs(width - this.lastWidth) < 16) return;
    this.lastWidth = width;
    if (plot.setAttribute('width', width)) plot.render();
  }
}

export class ChartGrid {
  private cards: ChartCard[] = [];
  private container: HTMLElement;
  private ctx: GridContext;

  constructor(container: HTMLElement, ctx: GridContext) {
    this.container = container;
    this.ctx = ctx;
  }

  get configs(): ChartConfig[] {
    return this.cards.map((c) => c.config);
  }

  async add(config: ChartConfig) {
    const card = new ChartCard(config, this.ctx, (c) => this.remove(c));
    this.cards.push(card);
    this.container.appendChild(card.element);
    await card.rebuild();
  }

  remove(card: ChartCard) {
    card.dispose();
    card.element.remove();
    this.cards = this.cards.filter((c) => c !== card);
  }

  /** 設定を部分的に変えて作り直す（機械学習の結果を軸・色に使うときなど）。 */
  async update(id: number, patch: Partial<ChartConfig>) {
    const card = this.cards.find((c) => c.config.id === id);
    if (!card) return;
    Object.assign(card.config, patch);
    await card.rebuild();
  }

  /** 全カードを作り直す（列が追加されて選択肢が変わったときなど）。 */
  async rebuildAll() {
    await Promise.all(this.cards.map((c) => c.rebuild()));
  }

  refreshRegression() {
    for (const c of this.cards) c.renderRegression();
  }

  resize() {
    for (const c of this.cards) c.resize();
  }

  clear() {
    for (const c of this.cards) {
      c.dispose();
      c.element.remove();
    }
    this.cards = [];
  }
}
