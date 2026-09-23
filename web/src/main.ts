// Brushlink Web版。
//
// CLAUDE.md「次にやること」1〜6 の画面の組み立てと各モジュールの配線を担う。
// 集計・検定・フィルタ・チャート生成・機械学習のロジックはそれぞれのモジュール
// （stats / inference / categories / regression / filters / charts / ml*）に置き、
// ここには置かない。
//
// Selection は3つある:
//   $filter   … 絞り込みパネルの条件（母集団）
//   $brush    … チャート間のマーキング（crossfilter。$filter を含む）
//   $selected … $brush と同じ条件を intersect で持つもの。crossfilter は
//               「自分のチャートの選択は自分に効かせない」ので、チャートの外で
//               選択中の行そのものを知りたいもの（統計量・回帰・データ表・
//               機械学習）はこちらを使う

import './style.css';
import { DuckDBWASMConnector, coordinator, Selection } from '@uwdata/vgplot';
import type { Coordinator } from '@uwdata/vgplot';
import type { SelectionClause } from '@uwdata/mosaic-core';
import type * as duckdbWasm from '@duckdb/duckdb-wasm';
import {
  UploadError,
  parseRaw,
  previewRows,
  guessHeaderRow,
  rowsToCsv,
  registerCsvTable,
} from './upload';
import type { LoadedTable } from './upload';
import { classifyColumns, buildFilterPanel, newFilterSelection } from './filters';
import type { ClassifiedColumns, FilterPanel, MissingIncludedEntry } from './filters';
import {
  pickBestAxisPair,
  buildScatterPlot,
  buildHistogram,
  buildColorLegend,
  DOT_TO_RASTER_THRESHOLD,
} from './charts';
import { connectStatsClients, connectLiveCount, renderStatsTable, compareNumeric, formatStat } from './stats';
import type { StatsSnapshot } from './stats';
import { connectCategoryClients, renderCategoryComparison, compareCategories } from './categories';
import type { CategoryCounts } from './categories';
import { connectRegressionClients, renderRegression } from './regression';
import type { RegressionResult } from './regression';
import { renderInsights } from './insights';
import { connectRowsClient } from './rows';
import { createMLPanel } from './mlPanel';
import type { MLPanel, MLTab, AddedColumns } from './mlPanel';
import { composeFigure, downloadPng, downloadSvg } from './export';
import { predicateSql } from './sql';
import { settledMirror } from './settle';
import { escapeHtml, helpTip, toast, installHelpTooltips } from './dom';
import { generateSampleRows, SAMPLE_FILE_NAME } from './sample';

const LOGO = `
  <svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="2.5" y="2.5" width="12" height="12" rx="2.5" fill="currentColor" opacity=".12"/>
    <rect x="2.5" y="2.5" width="12" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="3 2"/>
    <circle cx="6.5" cy="9" r="1.7" fill="currentColor"/><circle cx="10.5" cy="6.5" r="1.7" fill="currentColor"/>
    <circle cx="17.5" cy="16" r="1.7" fill="currentColor" opacity=".35"/><circle cx="20.5" cy="20.5" r="1.7" fill="currentColor" opacity=".35"/>
  </svg>`;

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header class="app-header">
    <div class="brand">${LOGO}<span>Brushlink</span></div>
    <p class="tagline">ドラッグで選ぶだけのデータ探索。データはブラウザの外に出ません。</p>
    <button type="button" id="helpButton" class="ghost-button">使い方と用語</button>
  </header>

  <main class="layout">
    <aside class="sidebar">
      <section class="panel" id="upload-section">
        <h2><span class="step">1</span>データ</h2>
        <div id="dropzone" tabindex="0" role="button" class="disabled" aria-disabled="true">
          <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M12 16V4m0 0l-4 4m4-4l4 4M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <strong>CSV / Excel をドロップ</strong>
          <span>またはクリックして選択</span>
        </div>
        <input type="file" id="fileInput" accept=".csv,.xlsx,.xls" hidden />
        <button type="button" id="sampleButton" class="secondary-button" disabled>サンプルデータで試す</button>
        <div id="uploadStatus" class="status"></div>
        <details id="previewDetails" hidden>
          <summary>ヘッダ行と列の型を確認・変更</summary>
          <p class="hint">
            先頭数行のプレビュー。ヘッダにする行をクリックして選ぶ
            （自動推定した行を初期選択にしてある）。
          </p>
          <div class="table-scroll"><table id="previewTable" class="mini-table"></table></div>
          <div id="uploadResult" class="table-scroll"></div>
        </details>
      </section>

      <section class="panel" id="view-section" hidden>
        <h2><span class="step">2</span>表示</h2>
        <div class="field-grid">
          <label for="xAxisSelect">X軸</label><select id="xAxisSelect"></select>
          <label for="yAxisSelect">Y軸</label><select id="yAxisSelect"></select>
          <label for="colorSelect">色分け</label><select id="colorSelect"></select>
        </div>
        <label class="inline-check"><input type="checkbox" id="regressionToggle" checked> 回帰直線を表示</label>
      </section>

      <section class="panel" id="filter-section" hidden>
        <div class="panel-head">
          <h2><span class="step">3</span>絞り込み</h2>
          <button type="button" id="filterReset" class="link-button">すべてリセット</button>
        </div>
        <p class="hint">分析の対象（母集団）を絞ります。チャート上の選択は、絞った中で行われます。</p>
        <div id="filterExclusionNote" class="note warn"></div>
        <div id="filterMissingNote" class="note info"></div>
        <div id="filterPanel"></div>
      </section>
    </aside>

    <div class="content">
      <section id="welcome" class="welcome">
        <div class="welcome-text">
          <h1>表データを、<em>ドラッグ</em>で探索する。</h1>
          <p>散布図の気になる範囲を囲むだけで、選んだ行が他と何が違うのかを、グラフと統計と機械学習でその場で比べられます。</p>
          <div class="welcome-actions">
            <button type="button" id="welcomeSample" class="primary-button large" disabled>サンプルデータで試す</button>
            <button type="button" id="welcomeFile" class="secondary-button large inline" disabled>自分のファイルを開く</button>
          </div>
          <p class="welcome-privacy">🔒 ファイルはブラウザの中だけで処理され、どこにも送信されません。</p>
        </div>
        <ol class="welcome-steps">
          <li><span class="step-num">1</span><div><strong>読み込む</strong><p>CSV / Excel を置くだけ。見出し行も列の型も自動で判定します。</p></div></li>
          <li><span class="step-num">2</span><div><strong>ドラッグで選ぶ</strong><p>散布図やヒストグラムの上を囲むと、他のグラフと数値が一斉に連動します。</p></div></li>
          <li><span class="step-num">3</span><div><strong>違いを読む</strong><p>選んだ行の特徴を文章で要約。検定・回帰・クラスタ分析まで一画面で。</p></div></li>
        </ol>
      </section>

      <section id="summaryBar" class="summary-bar" hidden>
        <div class="summary-counts">
          <div class="count count-selected">
            <span class="count-label">選択中 ${helpTip('チャート上でドラッグして選んだ行。選んでいないときは母集団すべて。')}</span>
            <span class="count-value" id="selectedCount">-</span>
            <span class="count-sub" id="selectedRate"></span>
          </div>
          <div class="count count-population">
            <span class="count-label">母集団 ${helpTip('左の「絞り込み」を通過した行。チャートの選択や統計は、この中で行われる。')}</span>
            <span class="count-value" id="populationCount">-</span>
            <span class="count-sub" id="populationRate"></span>
          </div>
          <div class="count count-total">
            <span class="count-label">全体</span>
            <span class="count-value" id="totalCount">-</span>
            <span class="count-sub" id="totalSub"></span>
          </div>
          <button type="button" id="clearSelection" class="ghost-button" disabled title="Esc キーでも解除できます">選択を解除</button>
        </div>
        <div class="count-bar" aria-hidden="true">
          <div class="count-bar-population" id="populationBar"></div>
          <div class="count-bar-selected" id="selectedBar"></div>
        </div>
        <div id="conditionChips" class="chips"></div>
      </section>

      <section id="insightCard" class="card insight-card" hidden aria-live="polite"></section>

      <section id="chart-card" class="card" hidden>
        <div class="card-head">
          <h2>チャート</h2>
          <div class="card-actions">
            <span id="chartStatus" class="status muted"></span>
            <button type="button" id="exportPng" class="ghost-button small">PNG で保存</button>
            <button type="button" id="exportSvg" class="ghost-button small">SVG で保存</button>
          </div>
        </div>
        <p class="hint" id="chartHint"></p>
        <div class="plots-wrap">
          <div id="coachMark" class="coach-mark" hidden>
            <span class="coach-hand" aria-hidden="true">👆</span>
            <span>ここをドラッグして範囲を選択</span>
          </div>
          <div id="plots" class="plots"></div>
        </div>
        <div id="regressionSummary" class="regression"></div>
      </section>

      <section id="detail-card" class="card" hidden>
        <div class="tabs" role="tablist" aria-label="詳細">
          <button type="button" role="tab" data-tab="stats" aria-selected="true">統計量</button>
          <button type="button" role="tab" data-tab="categories" aria-selected="false">カテゴリ構成</button>
          <span class="tab-sep">機械学習</span>
          <button type="button" role="tab" data-tab="cluster" aria-selected="false">クラスタ</button>
          <button type="button" role="tab" data-tab="pca" aria-selected="false">主成分</button>
          <button type="button" role="tab" data-tab="importance" aria-selected="false">変数重要度</button>
          <span class="tab-sep"></span>
          <button type="button" role="tab" data-tab="rows" aria-selected="false">行データ</button>
        </div>
        <div role="tabpanel" data-panel="stats">
          <p class="hint" id="statsScope"></p>
          <div id="statsTable" class="table-scroll"></div>
        </div>
        <div role="tabpanel" data-panel="categories" hidden><div id="categoryPanel"></div></div>
        <div role="tabpanel" data-panel="cluster" hidden><div id="clusterPanel" class="ml-panel"></div></div>
        <div role="tabpanel" data-panel="pca" hidden><div id="pcaPanel" class="ml-panel"></div></div>
        <div role="tabpanel" data-panel="importance" hidden><div id="importancePanel" class="ml-panel"></div></div>
        <div role="tabpanel" data-panel="rows" hidden><div id="rowsPanel"></div></div>
      </section>
    </div>
  </main>

  <dialog id="helpDialog" class="help-dialog">
    <form method="dialog" class="help-inner">
      <div class="help-head">
        <h2>使い方と用語</h2>
        <button class="ghost-button small" value="close" aria-label="閉じる">閉じる</button>
      </div>
      <h3>基本の流れ</h3>
      <ol>
        <li><strong>データを読み込む</strong> — CSV / Excel をドロップ。見出し行は自動で判定し、外れていたら「ヘッダ行と列の型を確認・変更」から選び直せます。</li>
        <li><strong>チャートをドラッグ</strong> — 散布図は四角く、ヒストグラムは横に囲みます。何もない所をクリックするか Esc キーで解除。</li>
        <li><strong>違いを読む</strong> — 上の要約、下の「統計量」「カテゴリ構成」、機械学習のタブで、選んだ行と残りの行を比べます。</li>
        <li><strong>図を保存</strong> — 「PNG で保存」で、条件の注記つきの図を書き出せます。</li>
      </ol>
      <h3>用語</h3>
      <dl>
        <dt>全体 / 母集団 / 選択中 / 選択外</dt><dd>全体は読み込んだ全行。母集団は左の「絞り込み」を通った行。選択中はチャートで囲んだ行、選択外は母集団のうち選んでいない行です。</dd>
        <dt>欠測</dt><dd>値が空のセル。平均などは欠測を除いて計算し、件数は常に表示します。</dd>
        <dt>効果量 d</dt><dd>2つの群の平均の差を標準偏差で割った値。単位の違う列どうしで「どれだけ違うか」を比べられます。0.2 小・0.5 中・0.8 大が目安。</dd>
        <dt>p 値</dt><dd>その差が偶然で生じる確率の目安。0.05 未満なら「偶然とは考えにくい」とされます。件数が多いと小さな差でも小さくなるので、効果量と合わせて見ます。</dd>
        <dt>回帰直線・R²</dt><dd>点に最もよく当てはまる直線。R² は直線で説明できるばらつきの割合（0〜1）。</dd>
        <dt>クラスタ（k-means）</dt><dd>似た行どうしを自動でグループ分けする方法。結果は列として追加でき、色分けに使えます。</dd>
        <dt>主成分（PCA）</dt><dd>多くの列を少数の軸にまとめる方法。結果を散布図の軸にすると、全体の構造を一枚で眺められます。</dd>
        <dt>変数重要度</dt><dd>選んだ行を残りと見分けるのに、どの列が役立つかの順位（ランダムフォレスト）。</dd>
      </dl>
      <p class="muted">選択に使った列そのものは、差が出て当然なので要約や重要度から除いています。</p>
    </form>
  </dialog>
`;

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;

installHelpTooltips();

const dropzoneEl = $<HTMLDivElement>('#dropzone');
const fileInputEl = $<HTMLInputElement>('#fileInput');
const sampleButtonEl = $<HTMLButtonElement>('#sampleButton');
const welcomeSampleEl = $<HTMLButtonElement>('#welcomeSample');
const welcomeFileEl = $<HTMLButtonElement>('#welcomeFile');
const uploadStatusEl = $<HTMLDivElement>('#uploadStatus');
const previewDetailsEl = $<HTMLDetailsElement>('#previewDetails');
const previewTableEl = $<HTMLTableElement>('#previewTable');
const uploadResultEl = $<HTMLDivElement>('#uploadResult');

const viewSectionEl = $<HTMLElement>('#view-section');
const xAxisSelectEl = $<HTMLSelectElement>('#xAxisSelect');
const yAxisSelectEl = $<HTMLSelectElement>('#yAxisSelect');
const colorSelectEl = $<HTMLSelectElement>('#colorSelect');
const regressionToggleEl = $<HTMLInputElement>('#regressionToggle');
const filterSectionEl = $<HTMLElement>('#filter-section');
const filterResetEl = $<HTMLButtonElement>('#filterReset');
const filterMissingNoteEl = $<HTMLDivElement>('#filterMissingNote');
const filterExclusionNoteEl = $<HTMLDivElement>('#filterExclusionNote');
const filterPanelEl = $<HTMLDivElement>('#filterPanel');

const welcomeEl = $<HTMLElement>('#welcome');
const summaryBarEl = $<HTMLElement>('#summaryBar');
const selectedCountEl = $<HTMLSpanElement>('#selectedCount');
const selectedRateEl = $<HTMLSpanElement>('#selectedRate');
const populationCountEl = $<HTMLSpanElement>('#populationCount');
const populationRateEl = $<HTMLSpanElement>('#populationRate');
const totalCountEl = $<HTMLSpanElement>('#totalCount');
const totalSubEl = $<HTMLSpanElement>('#totalSub');
const populationBarEl = $<HTMLDivElement>('#populationBar');
const selectedBarEl = $<HTMLDivElement>('#selectedBar');
const clearSelectionEl = $<HTMLButtonElement>('#clearSelection');
const conditionChipsEl = $<HTMLDivElement>('#conditionChips');
const insightCardEl = $<HTMLElement>('#insightCard');
const chartCardEl = $<HTMLElement>('#chart-card');
const chartStatusEl = $<HTMLSpanElement>('#chartStatus');
const chartHintEl = $<HTMLParagraphElement>('#chartHint');
const coachMarkEl = $<HTMLDivElement>('#coachMark');
const plotsEl = $<HTMLDivElement>('#plots');
const regressionSummaryEl = $<HTMLDivElement>('#regressionSummary');
const exportPngEl = $<HTMLButtonElement>('#exportPng');
const exportSvgEl = $<HTMLButtonElement>('#exportSvg');
const detailCardEl = $<HTMLElement>('#detail-card');
const statsScopeEl = $<HTMLParagraphElement>('#statsScope');
const statsTableEl = $<HTMLDivElement>('#statsTable');
const categoryPanelEl = $<HTMLDivElement>('#categoryPanel');
const rowsPanelEl = $<HTMLDivElement>('#rowsPanel');
const helpDialogEl = $<HTMLDialogElement>('#helpDialog');

$<HTMLButtonElement>('#helpButton').addEventListener('click', () => helpDialogEl.showModal());
// ダイアログの外側（背景）をクリックしても閉じる
helpDialogEl.addEventListener('click', (e) => {
  if (e.target === helpDialogEl) helpDialogEl.close();
});

function setUploadStatus(message: string, kind: 'info' | 'ok' | 'error') {
  uploadStatusEl.textContent = message;
  uploadStatusEl.dataset.kind = kind;
}

function setChartStatus(message: string, isError: boolean) {
  chartStatusEl.textContent = message;
  chartStatusEl.classList.toggle('error', isError);
}

// ---------------------------------------------------------------------------
// 詳細カードのタブ
// ---------------------------------------------------------------------------

type DetailTab = 'stats' | 'categories' | 'rows' | MLTab;
let activeTab: DetailTab = 'stats';
// ファイルを読み込むたびに作り直す。タブ切り替えから機械学習の計算を起動するため
let mlPanel: MLPanel | null = null;

function isMLTab(tab: DetailTab): tab is MLTab {
  return tab === 'cluster' || tab === 'pca' || tab === 'importance';
}

function selectTab(tab: DetailTab) {
  activeTab = tab;
  detailCardEl.querySelectorAll<HTMLButtonElement>('[role="tab"]').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  });
  detailCardEl.querySelectorAll<HTMLElement>('[role="tabpanel"]').forEach((p) => {
    p.hidden = p.dataset.panel !== tab;
  });
  // 機械学習は重いので、そのタブを開いている間だけ計算する
  mlPanel?.setActive(isMLTab(tab) ? tab : null);
}

detailCardEl.querySelectorAll<HTMLButtonElement>('[role="tab"]').forEach((b) => {
  b.addEventListener('click', () => selectTab(b.dataset.tab as DetailTab));
});

// ---------------------------------------------------------------------------
// ファイル読み込みまわり
// ---------------------------------------------------------------------------

/**
 * 先頭数行のプレビューを表として描画する。各行の先頭セルに
 * 「この行をヘッダにする」ラジオボタンを置き、クリックで選び直せるようにする。
 * 数値入力のヘッダ行指定は置かない。
 *
 * プレビューは折りたたみ（<details>）の中に置く。自動推定が当たっていれば
 * 初心者は開く必要がなく、外れたときやデータサイエンティストが確認したい
 * ときだけ開けばよい（製品方針「初期状態は自動、操作すれば細かく変更できる」）。
 */
function renderPreview(rows: unknown[][], headerRow: number, onSelect: (row: number) => void) {
  const rowsToShow = previewRows(rows);
  const maxCols = Math.max(...rowsToShow.map((r) => r.length), 1);

  const thead = `
    <thead><tr><th>ヘッダ</th>${Array.from({ length: maxCols }, (_, i) => `<th>列${i}</th>`).join('')}</tr></thead>
  `;
  const tbody = rowsToShow
    .map((row, i) => {
      const cells = Array.from({ length: maxCols }, (_, c) => {
        const v = row[c];
        return `<td>${v === null || v === undefined ? '' : escapeHtml(String(v))}</td>`;
      }).join('');
      const checked = i === headerRow ? 'checked' : '';
      return `<tr class="${checked ? 'is-header' : ''}"><td><input type="radio" name="headerRowChoice" value="${i}" ${checked} aria-label="${i}行目をヘッダにする"></td>${cells}</tr>`;
    })
    .join('');

  previewTableEl.innerHTML = thead + `<tbody>${tbody}</tbody>`;
  previewDetailsEl.hidden = false;

  previewTableEl.querySelectorAll<HTMLInputElement>('input[name="headerRowChoice"]').forEach((input) => {
    input.addEventListener('change', () => {
      previewTableEl.querySelectorAll('tr.is-header').forEach((tr) => tr.classList.remove('is-header'));
      input.closest('tr')?.classList.add('is-header');
      onSelect(Number(input.value));
    });
  });
}

/**
 * 「欠測を含める」チェックボックスが現在オンになっている列の一覧を、
 * 絞り込みパネルの先頭に注記として出す。列ごとに欠測件数も添えて、
 * どれだけの行がレンジ・チェックボックスの条件をすり抜けて通っているかが
 * 見えるようにする。
 */
function renderMissingIncludedNote(entries: MissingIncludedEntry[]) {
  if (entries.length === 0) {
    filterMissingNoteEl.textContent = '';
    return;
  }
  const detail = entries.map((e) => `${e.column}（${e.nullCount.toLocaleString()}件）`).join('、');
  filterMissingNoteEl.textContent = `欠測を含めている列: ${detail}`;
}

function populateSelect(
  select: HTMLSelectElement,
  options: { value: string; label: string }[],
  selected: string
) {
  select.innerHTML = options
    .map(
      (o) =>
        `<option value="${escapeHtml(o.value)}" ${o.value === selected ? 'selected' : ''}>${escapeHtml(o.label)}</option>`
    )
    .join('');
}

function percent(part: number, whole: number): string {
  if (whole <= 0) return '—';
  const p = (part / whole) * 100;
  return `${p >= 10 || p === 0 ? p.toFixed(0) : p.toFixed(1)}%`;
}

/**
 * プロットの横幅を、置き場所の幅から決める。固定幅だと狭い画面で
 * 横スクロールが出て、広い画面では余白ばかりになるため。
 * 幅が変わったらチャートを作り直す必要があるが、リサイズ追従までは
 * しない（作り直すと選択が消えるため、ファイル読み込み・軸変更時に
 * 合わせて決める程度で十分と判断）。
 */
function plotSizes(): { scatter: number; hist: number } {
  const available = Math.max(plotsEl.clientWidth, 320);
  if (available >= 900) {
    const scatter = Math.floor(available * 0.58);
    return { scatter, hist: available - scatter - 24 };
  }
  return { scatter: available, hist: available };
}

// ---------------------------------------------------------------------------
// ブラシ（チャート上の範囲選択）の状態
// ---------------------------------------------------------------------------

// 絞り込みパネルが $filter に書き込む節の source には kind が付いている
// （filters.ts）。$brush には絞り込みの節も合流しているので、それ以外を
// 「チャートで選んだ節」とみなす
function isFilterClause(clause: SelectionClause): boolean {
  const kind = (clause.source as { kind?: string } | undefined)?.kind;
  return kind === 'numeric-filter' || kind === 'category-filter';
}

function brushClauses($brush: Selection): SelectionClause[] {
  return $brush.clauses.filter((c) => !isFilterClause(c) && c.predicate !== null && c.predicate !== undefined);
}

function fieldName(field: unknown): string | null {
  if (typeof field === 'string') return field;
  const column = (field as { column?: unknown } | null)?.column;
  return typeof column === 'string' ? column : null;
}

/**
 * チャートで範囲を選ぶのに使った列と、その範囲の説明文。
 * 範囲の値は interactor（intervalX / intervalXY）が節に持たせる value から読む。
 */
function describeBrush($brush: Selection): { cols: Set<string>; texts: string[] } {
  const cols = new Set<string>();
  const texts: string[] = [];
  for (const clause of brushClauses($brush)) {
    const src = clause.source as { field?: unknown; xfield?: unknown; yfield?: unknown };
    const value = clause.value as unknown;
    const range = (name: string | null, v: unknown) => {
      if (!name) return;
      cols.add(name);
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number') {
        texts.push(`${name} ${formatStat(v[0])}〜${formatStat(v[1] as number)}`);
      }
    };
    if (src.xfield !== undefined || src.yfield !== undefined) {
      const [xr, yr] = Array.isArray(value) ? value : [];
      range(fieldName(src.xfield), xr);
      range(fieldName(src.yfield), yr);
    } else {
      range(fieldName(src.field), value);
    }
  }
  return { cols, texts };
}

// ---------------------------------------------------------------------------
// データ読み込み後の組み立て
// ---------------------------------------------------------------------------

// 散布図の名前に付ける連番。凡例は名前で散布図を引くため、別ファイルを
// 読み込んだ後も含めて一意にする（重複すると vgplot が古い図を上書きする）
let plotSerial = 0;
// 使い方の吹き出し（コーチマーク）は、最初に一度選択できたら二度と出さない
let hasEverSelected = false;

/**
 * アップロード成功後、画面全体（表示設定・絞り込み・チャート・統計・
 * 機械学習）を組み立てる。
 *
 * 別ファイルを読み込むたびに呼ばれる。Selection は毎回新しく作り直し、
 * 古い列に対する条件が新しいテーブルに引き継がれないようにする。
 * db.clear() で古いチャート・集計クライアントも切断する
 * （絞り込み用ウィジェット自体は MosaicClient として登録していないため
 * 影響を受けない）。
 */
async function setupDashboard(db: Coordinator, table: LoadedTable, fileName: string) {
  welcomeEl.hidden = true;
  chartCardEl.hidden = false;
  setChartStatus('列を調べています…', false);
  for (const el of [summaryBarEl, insightCardEl, detailCardEl, viewSectionEl, filterSectionEl]) el.hidden = true;
  filterMissingNoteEl.textContent = '';
  filterExclusionNoteEl.textContent = '';
  filterPanelEl.innerHTML = '';
  plotsEl.innerHTML = '';
  regressionSummaryEl.innerHTML = '';
  statsTableEl.innerHTML = '';
  categoryPanelEl.innerHTML = '';
  rowsPanelEl.innerHTML = '';
  mlPanel = null;

  db.clear(); // 古いチャート・集計クライアントを切断する（既定で clients・cache とも true）

  let cols: ClassifiedColumns;
  try {
    cols = await classifyColumns(db, table.tableName, table.columns);
  } catch (e) {
    setChartStatus(`⚠️ 列の分類に失敗しました: ${e instanceof Error ? e.message : String(e)}`, true);
    return;
  }

  if (cols.highCardCols.length > 0) {
    const detail = cols.highCardCols
      .map((c) => `${c.name}（${c.cardinality.toLocaleString()}種）`)
      .join('、');
    filterExclusionNoteEl.textContent = `種類が多すぎる列は絞り込み・色分けから除外: ${detail}`;
  }

  const $filter = newFilterSelection();
  const $brush = Selection.crossfilter({ include: [$filter] });
  const $selected = Selection.intersect({ include: [$brush] });
  // 集計系（統計量・カテゴリ・回帰・データ表）はドラッグが止まってから追従させる
  // （settle.ts）。件数だけは軽いので $selected で即時に更新する
  const $populationSettled = settledMirror($filter);
  const $selectedSettled = settledMirror($selected);

  // 機械学習で列を追加すると増える、軸・色分け・データ表の候補
  const axisCols = [...cols.numericCols];
  const colorCols = [...cols.catCols];
  const rowColumns = table.columns.map((c) => c.name);
  let filterDescriptions: string[] = [];

  // ---- 集計結果の置き場と描画 ----
  const state: {
    selStats: StatsSnapshot | null;
    popStats: StatsSnapshot | null;
    selCats: CategoryCounts | null;
    popCats: CategoryCounts | null;
    selReg: RegressionResult | null;
    popReg: RegressionResult | null;
    axisNote: string | null;
    liveSelected: number | null; // ドラッグ中も即時に更新する選択件数
  } = {
    selStats: null,
    popStats: null,
    selCats: null,
    popCats: null,
    selReg: null,
    popReg: null,
    axisNote: null,
    liveSelected: null,
  };

  let renderQueued = false;
  // 集計クライアントは別々に結果を返すので、1フレームにまとめて描き直す
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderAll();
    });
  }

  /**
   * 件数の表示。選択件数はドラッグ中も即時に（state.liveSelected）、
   * 母集団の件数は集計が落ち着いてから（state.popStats）更新する。
   */
  function renderCounts() {
    const { popStats, liveSelected } = state;
    if (!popStats || liveSelected === null) return;
    const hasSelection = brushClauses($brush).length > 0;
    populationCountEl.textContent = popStats.rows.toLocaleString();
    populationRateEl.textContent =
      popStats.rows === table.rowCount ? '絞り込みなし' : `全体の ${percent(popStats.rows, table.rowCount)}`;
    populationBarEl.style.width = `${(popStats.rows / table.rowCount) * 100}%`;
    selectedCountEl.textContent = hasSelection ? liveSelected.toLocaleString() : '—';
    selectedRateEl.textContent = hasSelection ? `母集団の ${percent(liveSelected, popStats.rows)}` : 'ドラッグで選択';
    selectedBarEl.style.width = hasSelection ? `${(liveSelected / table.rowCount) * 100}%` : '0';
    summaryBarEl.classList.toggle('has-selection', hasSelection);
    clearSelectionEl.disabled = !hasSelection;
    if (hasSelection) {
      hasEverSelected = true;
      coachMarkEl.hidden = true;
    }
  }

  function renderAll() {
    const { selStats, popStats } = state;
    if (!selStats || !popStats) return;
    const brush = describeBrush($brush);
    const hasSelection = brushClauses($brush).length > 0;
    renderCounts();

    // 条件のチップ（選択範囲・絞り込み）
    conditionChipsEl.innerHTML = [
      ...brush.texts.map((t) => `<span class="chip chip-brush" title="チャートで選んだ範囲">選択: ${escapeHtml(t)}</span>`),
      ...filterDescriptions.map((t) => `<span class="chip chip-filter" title="絞り込み条件">絞り込み: ${escapeHtml(t)}</span>`),
    ].join('');

    // 文章要約
    const numericCmp = hasSelection ? compareNumeric(cols.numericCols, selStats, popStats) : [];
    const catCmp =
      hasSelection && state.selCats && state.popCats ? compareCategories(cols.catCols, state.selCats, state.popCats) : [];
    renderInsights(insightCardEl, {
      hasSelection,
      selectedCount: selStats.rows,
      populationCount: popStats.rows,
      numeric: numericCmp,
      categorical: catCmp,
      brushedCols: brush.cols,
      axisNote: state.axisNote,
    });

    // 統計量
    statsScopeEl.innerHTML = hasSelection
      ? `選択中の <strong>${selStats.rows.toLocaleString()}</strong> 件の統計量と、選択外（母集団の残り ${(popStats.rows - selStats.rows).toLocaleString()} 件）との比較。`
      : `母集団 <strong>${popStats.rows.toLocaleString()}</strong> 件の統計量。チャートで範囲を選ぶと、選んだ行と残りの行の比較（効果量・p 値）が加わります。`;
    if (cols.numericCols.length > 0) {
      renderStatsTable(statsTableEl, cols.numericCols, selStats, popStats, brush.cols, hasSelection);
    } else {
      statsTableEl.innerHTML = '<p class="muted">数値列がありません。</p>';
    }

    // カテゴリ構成
    if (state.selCats && state.popCats) {
      renderCategoryComparison(categoryPanelEl, cols.catCols, state.selCats, state.popCats, hasSelection);
    } else if (cols.catCols.length === 0) {
      categoryPanelEl.innerHTML = '<p class="muted">カテゴリ列がありません（数値以外の列で、種類が20以下のもの）。</p>';
    }

    // 回帰
    if (state.selReg && state.popReg && regressionToggleEl.checked && !plotsEl.hidden) {
      renderRegression(regressionSummaryEl, xAxisSelectEl.value, yAxisSelectEl.value, state.selReg, state.popReg, hasSelection);
    } else {
      regressionSummaryEl.innerHTML = '';
    }

    mlPanel?.scopeChanged();
  }

  function connectAnalysisClients(x: string | null, y: string | null) {
    connectLiveCount(db, table.tableName, $selected, (n) => {
      state.liveSelected = n;
      renderCounts();
    });
    connectStatsClients(db, table.tableName, cols.numericCols, $populationSettled, $selectedSettled, (sel, pop) => {
      state.selStats = sel;
      state.popStats = pop;
      scheduleRender();
    });
    connectCategoryClients(db, table.tableName, cols.catCols, $populationSettled, $selectedSettled, (sel, pop) => {
      state.selCats = sel;
      state.popCats = pop;
      scheduleRender();
    });
    if (x && y) {
      connectRegressionClients(db, table.tableName, x, y, $populationSettled, $selectedSettled, (sel, pop) => {
        state.selReg = sel;
        state.popReg = pop;
        scheduleRender();
      });
    }
    connectRowsClient(db, table.tableName, rowColumns, $selectedSettled, rowsPanelEl);
  }

  // ---- 絞り込みパネル ----
  let panel: FilterPanel;
  try {
    panel = await buildFilterPanel(db, table.tableName, cols, $filter, renderMissingIncludedNote, (descs) => {
      filterDescriptions = descs;
      scheduleRender();
    });
    filterPanelEl.appendChild(panel.element);
  } catch (e) {
    setChartStatus(`⚠️ 絞り込みパネルの構築に失敗しました: ${e instanceof Error ? e.message : String(e)}`, true);
    return;
  }
  // 別ファイル読み込み時に古いパネルの reset が残らないよう、onclick で上書きする
  filterResetEl.onclick = () => panel.reset();
  filterSectionEl.hidden = cols.numericCols.length + cols.catCols.length === 0;

  totalCountEl.textContent = table.rowCount.toLocaleString();
  totalSubEl.textContent = `${table.columns.length} 列（数値 ${cols.numericCols.length}）`;
  summaryBarEl.hidden = false;
  insightCardEl.hidden = false;
  detailCardEl.hidden = false;

  // ---- 選択の解除 ----
  function clearSelection() {
    const clauses = brushClauses($brush);
    if (clauses.length > 0) $brush.reset(clauses);
  }
  clearSelectionEl.onclick = clearSelection;
  document.onkeydown = (e) => {
    if (e.key === 'Escape' && !helpDialogEl.open) clearSelection();
  };

  // ---- 機械学習パネル ----
  mlPanel = createMLPanel({
    db,
    tableName: table.tableName,
    numericCols: cols.numericCols,
    existingCols: table.columns.map((c) => c.name),
    containers: {
      cluster: $<HTMLElement>('#clusterPanel'),
      pca: $<HTMLElement>('#pcaPanel'),
      importance: $<HTMLElement>('#importancePanel'),
    },
    getScope: () => ({
      selectedSql: predicateSql($selected.predicate(null)),
      populationSql: predicateSql($filter.predicate(null)),
      hasSelection: brushClauses($brush).length > 0,
      selectedCount: state.selStats?.rows ?? 0,
      populationCount: state.popStats?.rows ?? 0,
      brushedCols: describeBrush($brush).cols,
    }),
    onColumnsAdded: async (added: AddedColumns) => {
      axisCols.push(...added.numeric.filter((c) => !axisCols.includes(c)));
      colorCols.push(...added.categorical.filter((c) => !colorCols.includes(c)));
      rowColumns.push(...[...added.numeric, ...added.categorical].filter((c) => !rowColumns.includes(c)));
      const [x, y] = added.axes ?? [xAxisSelectEl.value, yAxisSelectEl.value];
      populateAxisSelects(x, y, added.color ?? colorSelectEl.value);
      // 列の値を書き換えたので、Mosaic の事前集計（crossfilter 高速化用の
      // 集計済みテーブル）を捨てる。残すと古い値の集計が使われてしまう
      await db.preaggregator.dropSchema();
      rebuildCharts();
    },
  });
  selectTab(activeTab);

  if (cols.numericCols.length < 2) {
    plotsEl.hidden = true;
    coachMarkEl.hidden = true;
    exportPngEl.hidden = exportSvgEl.hidden = true;
    chartHintEl.textContent = '';
    connectAnalysisClients(null, null);
    setChartStatus('散布図を描くには数値列が2つ以上必要です（絞り込みと統計量は利用できます）。', false);
    return;
  }
  plotsEl.hidden = false;
  exportPngEl.hidden = exportSvgEl.hidden = false;

  let pair;
  try {
    pair = await pickBestAxisPair(db, table.tableName, cols.numericCols);
  } catch (e) {
    setChartStatus(`⚠️ 軸の自動選択に失敗しました: ${e instanceof Error ? e.message : String(e)}`, true);
    return;
  }
  state.axisNote =
    pair.r !== null
      ? `散布図の軸は、相関がいちばん強い「${escapeHtml(pair.x)}」と「${escapeHtml(pair.y)}」（相関係数 r = ${pair.r.toFixed(2)}）を自動で選びました。左の「表示」で変えられます。`
      : null;

  const useRaster = table.rowCount >= DOT_TO_RASTER_THRESHOLD;

  function populateAxisSelects(x: string, y: string, color: string) {
    const numericOptions = axisCols.map((c) => ({ value: c, label: c }));
    populateSelect(xAxisSelectEl, numericOptions, x);
    populateSelect(yAxisSelectEl, numericOptions, y);
    // raster 描画のときは色分けできないため、セレクタごと無効にして理由を出す
    populateSelect(colorSelectEl, [{ value: '', label: '（なし）' }, ...colorCols.map((c) => ({ value: c, label: c }))], useRaster ? '' : color);
    colorSelectEl.disabled = useRaster || colorCols.length === 0;
    colorSelectEl.title = useRaster
      ? `行数が ${DOT_TO_RASTER_THRESHOLD.toLocaleString()} 件以上のため密度表示（raster）になり、色分けできません`
      : '';
  }
  // 色分けの初期値は最初のカテゴリ列（自動で組み立てる）。「なし」も選べる。
  populateAxisSelects(pair.x, pair.y, cols.catCols[0] ?? '');
  viewSectionEl.hidden = false;

  function rebuildCharts() {
    db.clear(); // 直前のチャート・集計クライアントを切断する
    // 軸が変わると古いブラシの範囲は新しいチャート上に描けないので、選択も解除する。
    // 残すと「見えない選択」が統計量に効き続けてしまう
    clearSelection();
    plotsEl.innerHTML = '';
    state.selReg = state.popReg = null;

    const xCol = xAxisSelectEl.value;
    const yCol = yAxisSelectEl.value;
    const colorCol = colorSelectEl.value || null;
    const sizes = plotSizes();
    // 凡例は名前で散布図を引くため、作り直すたびに別名にして古い図を掴まないようにする
    const plotName = `scatter-${++plotSerial}`;

    const scatter = buildScatterPlot({
      tableName: table.tableName,
      x: xCol,
      y: yCol,
      colorCol,
      rowCount: table.rowCount,
      population: $filter,
      brush: $brush,
      selected: $selectedSettled,
      showRegression: regressionToggleEl.checked,
      plotName,
      width: sizes.scatter,
      height: Math.round(Math.min(sizes.scatter * 0.75, 460)),
    });
    const histSize = { width: sizes.hist, height: 190 };
    const histX = buildHistogram(table.tableName, xCol, $filter, $brush, histSize);
    const histY = buildHistogram(table.tableName, yCol, $filter, $brush, histSize);

    const scatterWrap = document.createElement('div');
    scatterWrap.className = 'plot-main';
    if (colorCol) {
      const legend = document.createElement('div');
      legend.className = 'legend-wrap';
      legend.appendChild(buildColorLegend(plotName));
      scatterWrap.appendChild(legend);
    }
    scatterWrap.appendChild(scatter);
    const side = document.createElement('div');
    side.className = 'plot-side';
    side.append(histX, histY);
    plotsEl.append(scatterWrap, side);

    connectAnalysisClients(xCol, yCol);

    // raster の散布図は1層だけ（charts.ts 参照）なので、灰色の背景は出ない。
    // 説明文と見た目が食い違わないよう、そのときだけ一言添える
    chartHintEl.textContent =
      '散布図は四角く、ヒストグラムは横にドラッグして範囲を選びます。灰色は選択外、色付きが選択中。' +
      (useRaster ? '（密度表示の散布図には選択外は表示されません）' : '');
    coachMarkEl.hidden = hasEverSelected;
    setChartStatus(`${useRaster ? '密度表示' : '点表示'}・${table.rowCount.toLocaleString()} 行`, false);
  }

  // 別ファイルを読み込むたびにリスナーが積み重ならないよう、addEventListener
  // ではなく onchange で上書きする（積み重なると1回の変更でチャートが
  // 読み込んだファイル数だけ作り直され、古いテーブルの列名で描こうとする）
  xAxisSelectEl.onchange = rebuildCharts;
  yAxisSelectEl.onchange = rebuildCharts;
  colorSelectEl.onchange = rebuildCharts;
  regressionToggleEl.onchange = rebuildCharts;
  coachMarkEl.onclick = () => (coachMarkEl.hidden = true);

  // ---- 図の書き出し ----
  async function exportFigure(kind: 'png' | 'svg') {
    const brush = describeBrush($brush);
    const color = colorSelectEl.value;
    const caption = {
      title: `Brushlink — ${fileName}`,
      lines: [
        `X: ${xAxisSelectEl.value} / Y: ${yAxisSelectEl.value}${color ? ` / 色: ${color}` : ''}`,
        `${brush.texts.length ? `選択中 ${(state.selStats?.rows ?? 0).toLocaleString()} 件` : '選択なし'} / 母集団 ${(state.popStats?.rows ?? 0).toLocaleString()} 件 / 全体 ${table.rowCount.toLocaleString()} 件`,
        `選択範囲: ${brush.texts.join('、') || 'なし'}`,
        `絞り込み: ${filterDescriptions.join('、') || 'なし'}`,
      ],
    };
    const figure = composeFigure(plotsEl, caption);
    try {
      if (kind === 'png') await downloadPng(figure);
      else downloadSvg(figure);
      toast(`図を ${kind.toUpperCase()} で保存しました`);
    } catch (e) {
      toast(`⚠️ 図の保存に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  exportPngEl.onclick = () => exportFigure('png');
  exportSvgEl.onclick = () => exportFigure('svg');

  rebuildCharts();
}

/**
 * ドロップ領域・ファイル選択・サンプル・ヘッダ行クリックの一連を配線する。
 *
 * 読み込みトリガーは常に「プレビュー表の行クリック」に一本化してある
 * （Python版と同じ設計）。ファイルを受け取った直後は自動推定した行で
 * 一度読み込みを試みるが、それも `loadWithHeaderRow` を呼ぶだけで、
 * ユーザーが後から別の行をクリックした場合と同じ経路を通る。
 * サンプルデータも2次元配列として同じ経路に流す。
 */
function setupUpload(db: Coordinator, duckdb: duckdbWasm.AsyncDuckDB) {
  let currentRows: unknown[][] | null = null;
  let currentFileName = '';

  function showError(e: unknown) {
    const message =
      e instanceof UploadError
        ? e.message
        : `予期しないエラーが発生しました: ${e instanceof Error ? e.message : String(e)}`;
    setUploadStatus(`⚠️ ${message}`, 'error');
    uploadResultEl.innerHTML = '';
    // エラーの多くはヘッダ行の選択ミスなので、選び直せるよう折りたたみを開く
    if (!previewDetailsEl.hidden) previewDetailsEl.open = true;
  }

  async function loadWithHeaderRow(headerRow: number) {
    if (!currentRows) return;
    setUploadStatus(`「${currentFileName}」を読み込み中…`, 'info');
    uploadResultEl.innerHTML = '';

    try {
      const csvText = rowsToCsv(currentRows, headerRow);
      const table = await registerCsvTable(duckdb, db, 'uploaded', csvText);
      // テーブルを作り直したので、Mosaic の事前集計テーブルを捨てる。
      // 事前集計テーブルの名前はクエリ文字列のハッシュで決まるため、
      // 同じ列名の別ファイル（や別のヘッダ行）を読み込むと、古いデータの
      // 集計結果がそのまま再利用されてしまう
      await db.preaggregator.dropSchema();
      setUploadStatus(
        `${currentFileName}\n${table.rowCount.toLocaleString()} 行 × ${table.columns.length} 列（ヘッダ: ${headerRow} 行目）`,
        'ok'
      );
      const columnRows = table.columns
        .map((c) => `<tr><td>${escapeHtml(c.name)}</td><td><code>${escapeHtml(c.type)}</code></td></tr>`)
        .join('');
      uploadResultEl.innerHTML = `
        <table class="mini-table"><thead><tr><th>列名</th><th>DuckDBの型</th></tr></thead><tbody>${columnRows}</tbody></table>
      `;

      await setupDashboard(db, table, currentFileName);
    } catch (e) {
      showError(e);
    }
  }

  async function handleRows(name: string, rows: unknown[][]) {
    currentFileName = name;
    currentRows = rows;
    const guess = guessHeaderRow(rows);
    renderPreview(rows, guess, (row) => {
      loadWithHeaderRow(row);
    });
    await loadWithHeaderRow(guess);
  }

  async function handleFile(file: File) {
    setUploadStatus(`「${file.name}」を解析中…`, 'info');
    uploadResultEl.innerHTML = '';
    previewTableEl.innerHTML = '';
    previewDetailsEl.hidden = true;
    previewDetailsEl.open = false;
    currentRows = null;

    try {
      await handleRows(file.name, await parseRaw(file));
    } catch (e) {
      showError(e);
    }
  }

  function loadSample() {
    previewDetailsEl.open = false;
    handleRows(SAMPLE_FILE_NAME, generateSampleRows()).catch(showError);
  }

  fileInputEl.addEventListener('change', () => {
    const file = fileInputEl.files?.[0];
    if (file) handleFile(file);
    fileInputEl.value = ''; // 同じファイルを選び直しても change が発火するように
  });

  sampleButtonEl.addEventListener('click', loadSample);
  welcomeSampleEl.addEventListener('click', loadSample);
  welcomeFileEl.addEventListener('click', () => fileInputEl.click());

  dropzoneEl.addEventListener('click', () => fileInputEl.click());
  dropzoneEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInputEl.click();
    }
  });

  // ドロップ領域の外（ウェルカム画面など）に落としても読み込めるよう、
  // ページ全体でドロップを受ける。ブラウザがファイルを開いて画面遷移
  // してしまうのを防ぐ意味もある
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzoneEl.classList.add('dragover');
    document.body.classList.add('dragging');
  });
  document.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) {
      dropzoneEl.classList.remove('dragover');
      document.body.classList.remove('dragging');
    }
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzoneEl.classList.remove('dragover');
    document.body.classList.remove('dragging');
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });

  // DuckDB の初期化が済むまではボタン類を無効にしてある。ここで有効化する
  dropzoneEl.classList.remove('disabled');
  dropzoneEl.removeAttribute('aria-disabled');
  for (const b of [sampleButtonEl, welcomeSampleEl, welcomeFileEl]) b.disabled = false;
  setUploadStatus('', 'info');
}

async function main() {
  setUploadStatus('分析エンジン（DuckDB）を準備中…', 'info');
  const connector = new DuckDBWASMConnector();
  const db = coordinator();
  db.databaseConnector(connector);
  const duckdb = await connector.getDuckDB();

  setupUpload(db, duckdb);
}

main().catch((err) => {
  console.error(err);
  setUploadStatus(`⚠️ 初期化に失敗しました: ${err instanceof Error ? err.message : String(err)}`, 'error');
});
