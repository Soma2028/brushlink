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
  ALL_NUMERIC,
  MAX_SPLOM_COLUMNS,
} from './chartTypes';
import type { ChartConfig, ChartType, ColumnKinds } from './chartTypes';
import { newChart } from './chartTypes';
import {
  buildScatterPlot,
  buildHistogram,
  buildBarCount,
  buildBarMean,
  buildErrorBar,
  buildLine,
  buildColorLegend,
  buildResidual,
  buildSplom,
  DOT_TO_RASTER_THRESHOLD,
} from './charts';
import { buildCorrHeatmap, buildQQ, buildViolin } from './statCharts';
import type { StatChart } from './statCharts';
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
  populationSql: () => string; // 母集団の WHERE 条件（残差プロットの回帰直線の当てはめ用）
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
  qq: 280,
  violin: 300,
  residual: 300,
  corr: 360,
  splom: 0, // 列数で決まる
};

function option(value: string, label: string, selected: boolean): string {
  return `<option value="${escapeHtml(value)}" ${selected ? 'selected' : ''}>${escapeHtml(label)}</option>`;
}

class ChartCard {
  readonly element: HTMLElement;
  private body: HTMLElement;
  private regressionEl: HTMLElement;
  // vgplot の plot 要素（散布図行列は複数枚）と、自作のグラフ（statCharts.ts）
  private plots: PlotElement[] = [];
  private stat: StatChart | null = null;
  private extraClients: unknown[] = [];
  private unsubscribe: (() => void)[] = [];
  private regression: { sel: RegressionResult | null; pop: RegressionResult | null } = { sel: null, pop: null };
  private lastWidth = 0;
  private buildSerial = 0;

  config: ChartConfig;
  private ctx: GridContext;
  private onRemove: (card: ChartCard) => void;
  private onPickPair: (x: string, y: string) => void;

  constructor(
    config: ChartConfig,
    ctx: GridContext,
    onRemove: (card: ChartCard) => void,
    onPickPair: (x: string, y: string) => void
  ) {
    this.config = config;
    this.ctx = ctx;
    this.onRemove = onRemove;
    this.onPickPair = onPickPair;
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
    const multi = kinds.numeric.length >= 2 ? `<optgroup label="複数列">${option(ALL_NUMERIC, '（数値列すべて）', c.x === ALL_NUMERIC)}</optgroup>` : '';
    const controls: string[] = [
      `<label>X <select data-role="x">${multi}${xGroup(kindLabel.numeric, kinds.numeric)}${xGroup(kindLabel.category, kinds.category)}${xGroup(kindLabel.temporal, kinds.temporal)}</select></label>`,
      c.x === ALL_NUMERIC
        ? ''
        : `<label>Y <select data-role="y">${ys.allowNone ? option('', '（なし）', c.y === null) : ''}${ys.columns
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
    if (c.type === 'splom' && types.includes('splom') && kinds.numeric.length > MAX_SPLOM_COLUMNS) {
      // 数値列が上限より多いときは、並べる列をチェックで選ぶ（上限まで）
      const chosen = this.splomColumns();
      controls.push(
        `<fieldset class="column-picker"><legend>並べる列（${MAX_SPLOM_COLUMNS} 列まで）</legend>${kinds.numeric
          .map(
            (col) =>
              `<label class="inline-check"><input type="checkbox" data-role="splom-col" value="${escapeHtml(col)}" ${chosen.includes(col) ? 'checked' : ''} ${
                !chosen.includes(col) && chosen.length >= MAX_SPLOM_COLUMNS ? 'disabled' : ''
              }> ${escapeHtml(col)}</label>`
          )
          .join('')}</fieldset>`
      );
    }
    const box = this.element.querySelector('.chart-controls')!;
    box.innerHTML = controls.join('');
    box.querySelectorAll<HTMLInputElement>('[data-role="splom-col"]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const picked = [...box.querySelectorAll<HTMLInputElement>('[data-role="splom-col"]:checked')].map((x) => x.value);
        if (picked.length < 2) {
          cb.checked = true; // 2列未満では行列にならない
          return;
        }
        c.columns = picked;
        this.rebuild();
      });
    });

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

  /** 設定の選択肢だけを描き直す（グラフはそのまま）。 */
  refreshControls() {
    this.renderControls();
  }

  /** 散布図行列に並べる列。未指定なら数値列の先頭から上限まで。 */
  private splomColumns(): string[] {
    const numeric = this.ctx.getKinds().numeric;
    const chosen = (this.config.columns ?? []).filter((col) => numeric.includes(col));
    return (chosen.length >= 2 ? chosen : numeric).slice(0, MAX_SPLOM_COLUMNS);
  }

  private titleText(): string {
    const c = this.config;
    if (c.x === ALL_NUMERIC) {
      const cols = c.type === 'splom' ? this.splomColumns() : this.ctx.getKinds().numeric;
      return `${CHART_LABELS[c.type]} — ${cols.join('・')}`;
    }
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

    const needCategories = ['bar-count', 'bar-mean', 'errorbar', 'violin'].includes(c.type);
    const categories = needCategories ? await this.ctx.categoryValues(c.x) : [];
    const colorValues = c.type === 'scatter' && c.color && !this.useRaster ? await this.ctx.categoryValues(c.color) : null;
    // 取得を待つ間に別の設定変更が来ていたら、古い組み立ては捨てる
    if (serial !== this.buildSerial) return;

    const size = { width: Math.max(this.body.clientWidth, 280), height: CHART_HEIGHT[c.type] };
    this.lastWidth = size.width;
    const { tableName, population, brush } = this.ctx;
    const catCtx = { tableName, population, brush, selected: this.ctx.selectedLive, categories, size };

    const statCtx = {
      db: this.ctx.db,
      tableName,
      population: this.ctx.populationSettled,
      selected: this.ctx.selected,
      brush,
      hasSelection: this.ctx.hasSelection,
      width: size.width,
      height: size.height,
    };
    let plotEl: PlotElement | null = null;
    let content: HTMLElement | null = null;
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
      case 'qq':
        this.stat = buildQQ(c.x, statCtx);
        break;
      case 'violin':
        this.stat = await buildViolin(c.x, c.y!, categories, statCtx);
        if (serial !== this.buildSerial) return this.disposeStat();
        break;
      case 'corr':
        this.stat = buildCorrHeatmap(kinds.numeric, statCtx, this.onPickPair);
        break;
      case 'splom': {
        const splom = buildSplom(this.splomColumns(), {
          tableName,
          rowCount: this.ctx.rowCount,
          population,
          brush,
          width: size.width,
        });
        content = splom.element;
        this.plots = splom.plots as PlotElement[];
        break;
      }
      case 'residual': {
        const fit = await this.fetchFit(c.x, c.y!);
        if (serial !== this.buildSerial) return;
        if (!fit) {
          this.body.innerHTML = '<p class="chart-empty">回帰直線を当てはめられません（値が2件未満か、X が一定）。</p>';
          return;
        }
        plotEl = buildResidual(c.x, c.y!, fit, { tableName, rowCount: this.ctx.rowCount, population, brush, size });
        this.watchFit(c.x, c.y!, fit);
        break;
      }
    }
    if (plotEl) this.plots = [plotEl];
    this.body.replaceChildren();
    if (legend) {
      const wrap = document.createElement('div');
      wrap.className = 'legend-wrap';
      wrap.appendChild(legend);
      this.body.appendChild(wrap);
    }
    this.body.appendChild(this.stat?.element ?? content ?? plotEl!);
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

  /** 母集団で Y = a + bX を当てはめる（残差プロット用）。 */
  private async fetchFit(x: string, y: string): Promise<{ slope: number; intercept: number } | null> {
    const qx = `"${x.replace(/"/g, '""')}"`;
    const qy = `"${y.replace(/"/g, '""')}"`;
    const row: any = (
      await this.ctx.db.query(
        `SELECT regr_slope(${qy}, ${qx}) AS slope, regr_intercept(${qy}, ${qx}) AS intercept FROM "${this.ctx.tableName}" WHERE ${this.ctx.populationSql()}`,
        { cache: false }
      )
    ).get(0);
    const slope = Number(row.slope);
    const intercept = Number(row.intercept);
    return row.slope === null || !Number.isFinite(slope) || !Number.isFinite(intercept) ? null : { slope, intercept };
  }

  /**
   * 残差プロットの回帰直線は母集団で当てはめた定数なので、絞り込みで母集団が
   * 変わったら当てはめ直して描き直す（直線が変わらなければ何もしない）。
   */
  private watchFit(x: string, y: string, fit: { slope: number; intercept: number }) {
    const selection = this.ctx.populationSettled;
    const listener = async () => {
      const next = await this.fetchFit(x, y);
      const same = next && Math.abs(next.slope - fit.slope) < 1e-12 && Math.abs(next.intercept - fit.intercept) < 1e-12;
      if (!same) this.rebuild();
    };
    selection.addEventListener('value', listener);
    this.unsubscribe.push(() => selection.removeEventListener('value', listener));
  }

  private disposeStat() {
    for (const client of this.stat?.clients ?? []) this.ctx.db.disconnect(client as any);
    this.stat = null;
  }

  renderRegression() {
    const { sel, pop } = this.regression;
    if (!sel || !pop || this.config.type !== 'scatter' || !this.config.regression) return;
    renderRegression(this.regressionEl, this.config.x, this.config.y!, sel, pop, this.ctx.hasSelection());
  }

  /** このカードのグラフが作った選択の節（ブラシ・クリック）。 */
  ownClauses(): SelectionClause[] {
    const plots = new Set(this.plots.map((p) => p.value).filter(Boolean));
    return this.ctx.brush.clauses.filter((cl) => {
      const src = cl.source as { mark?: { plot?: unknown } } | undefined;
      return (src?.mark?.plot !== undefined && plots.has(src.mark.plot as PlotObject)) || !!this.stat?.owns(cl.source);
    });
  }

  /** グラフを切断して片付ける（選択の解除・集計クライアントの切断）。 */
  dispose() {
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
    for (const p of this.plots) {
      for (const m of p.value?.marks ?? []) if (m.coordinator) this.ctx.db.disconnect(m as any);
    }
    this.disposeStat();
    for (const client of this.extraClients) this.ctx.db.disconnect(client as any);
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    this.extraClients = [];
    this.plots = [];
    this.regression = { sel: null, pop: null };
  }

  /** 幅だけが変わったとき、作り直さずに描き直す（選択を保つため）。 */
  resize() {
    const width = Math.max(this.body.clientWidth, 280);
    if (Math.abs(width - this.lastWidth) < 16) return;
    this.lastWidth = width;
    this.stat?.resize(width);
    if (this.config.type === 'splom') {
      // 散布図行列は1マスずつの幅を変える（マスの数は変わらない）
      const k = this.plots.length ? Math.round(Math.sqrt(this.plots.length)) : 1;
      const cell = Math.max(90, Math.floor((width - 12) / k));
      const grid = this.body.querySelector<HTMLElement>('.splom');
      if (grid) grid.style.gridTemplateColumns = `repeat(${k}, ${cell}px)`;
      for (const p of this.plots) {
        const plot = p.value;
        if (plot && (plot.setAttribute('width', cell) || plot.setAttribute('height', cell))) plot.render();
      }
      return;
    }
    for (const p of this.plots) {
      const plot = p.value;
      if (plot?.setAttribute('width', width)) plot.render();
    }
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

  /**
   * 相関行列のセルがクリックされたら、最初の散布図の X・Y をその2列にする。
   * 散布図が無ければ1枚足す。
   */
  private async pickPair(x: string, y: string) {
    const scatter = this.cards.find((c) => c.config.type === 'scatter');
    if (scatter) {
      Object.assign(scatter.config, { x, y });
      await scatter.rebuild();
      scatter.element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      await this.add(newChart({ type: 'scatter', x, y }));
    }
  }

  async add(config: ChartConfig) {
    const card = new ChartCard(
      config,
      this.ctx,
      (c) => this.remove(c),
      (x, y) => this.pickPair(x, y)
    );
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

  /** 全カードを作り直す。 */
  async rebuildAll() {
    await Promise.all(this.cards.map((c) => c.rebuild()));
  }

  /**
   * 列が追加・書き換えられたとき。その列を使っているカードだけ作り直し、
   * 他のカードは設定の選択肢（X・Y・色の列）だけを更新する。全部を作り直すと、
   * 無関係なグラフの選択（ブラシ）まで消えてしまうため。
   */
  async columnsChanged(changed: string[]) {
    const uses = (c: ChartConfig) => changed.some((col) => c.x === col || c.y === col || c.color === col || c.columns?.includes(col));
    await Promise.all(this.cards.map((card) => (uses(card.config) ? card.rebuild() : card.refreshControls())));
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
