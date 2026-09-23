// Brushlink Web版。
//
// CLAUDE.md「次にやること」1（ファイル読み込み）・2（軸選択とフィルタパネル）・
// 3（統計量と選択件数の表示）。画面の組み立てと各モジュールの配線を担う。
// 集計・フィルタ・チャート生成のロジックはそれぞれ stats.ts / filters.ts /
// charts.ts に置き、ここには置かない。

import './style.css';
import { DuckDBWASMConnector, coordinator, Selection } from '@uwdata/vgplot';
import type { Coordinator } from '@uwdata/vgplot';
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
import type { FilterPanel, MissingIncludedEntry } from './filters';
import {
  pickBestAxisPair,
  buildScatterPlot,
  buildHistogram,
  buildColorLegend,
  DOT_TO_RASTER_THRESHOLD,
} from './charts';
import { connectStatsClients, renderStatsTable } from './stats';
import type { StatsSnapshot } from './stats';
import { generateSampleRows, SAMPLE_FILE_NAME } from './sample';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header class="app-header">
    <div class="brand">
      <svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="3" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 2"/>
        <circle cx="7" cy="9" r="1.6" fill="currentColor"/><circle cx="11" cy="6.5" r="1.6" fill="currentColor"/>
        <circle cx="17" cy="16" r="1.6" fill="currentColor" opacity=".35"/><circle cx="20" cy="20" r="1.6" fill="currentColor" opacity=".35"/>
      </svg>
      <span>Brushlink</span>
    </div>
    <p class="tagline">ブラウザ内で完結するクロスフィルタ探索。データはどこにも送信されません。</p>
  </header>

  <main class="layout">
    <aside class="sidebar">
      <section class="panel" id="upload-section">
        <h2>データ</h2>
        <div id="dropzone" tabindex="0" role="button" class="disabled" aria-disabled="true">
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
        <h2>表示</h2>
        <div class="field-grid">
          <label for="xAxisSelect">X軸</label><select id="xAxisSelect"></select>
          <label for="yAxisSelect">Y軸</label><select id="yAxisSelect"></select>
          <label for="colorSelect">色分け</label><select id="colorSelect"></select>
        </div>
      </section>

      <section class="panel" id="filter-section" hidden>
        <div class="panel-head">
          <h2>フィルタ</h2>
          <button type="button" id="filterReset" class="link-button">すべてリセット</button>
        </div>
        <p class="hint">母集団を絞り込みます。チャート上の選択は、絞り込んだ中で行われます。</p>
        <div id="filterExclusionNote" class="note warn"></div>
        <div id="filterMissingNote" class="note info"></div>
        <div id="filterPanel"></div>
      </section>
    </aside>

    <div class="content">
      <section id="emptyState" class="empty-state">
        <h2>データを読み込むと、ここにチャートが並びます</h2>
        <ol>
          <li>左の枠に CSV / Excel をドロップ（または「サンプルデータで試す」）</li>
          <li>散布図やヒストグラムの上を<strong>ドラッグ</strong>して範囲を選ぶ</li>
          <li>選んだ範囲が他のチャートと統計量に即座に反映される</li>
        </ol>
      </section>

      <section id="countTiles" class="count-tiles" hidden>
        <div class="tile tile-selected">
          <div class="tile-label">選択中</div>
          <div class="tile-value" id="selectedCount">-</div>
          <div class="tile-sub" id="selectedRate"></div>
        </div>
        <div class="tile tile-population">
          <div class="tile-label">母集団（フィルタ後）</div>
          <div class="tile-value" id="populationCount">-</div>
          <div class="tile-sub" id="populationRate"></div>
        </div>
        <div class="tile tile-total">
          <div class="tile-label">全体</div>
          <div class="tile-value" id="totalCount">-</div>
          <div class="tile-sub" id="totalSub"></div>
        </div>
        <div class="count-bar" aria-hidden="true">
          <div class="count-bar-population" id="populationBar"></div>
          <div class="count-bar-selected" id="selectedBar"></div>
        </div>
      </section>

      <section id="chart-card" class="card" hidden>
        <div class="card-head">
          <h2>チャート</h2>
          <span id="chartStatus" class="status muted"></span>
        </div>
        <p class="hint" id="chartHint">ドラッグで範囲を選択（マーキング）。何もない所をクリックすると選択を解除します。灰色は母集団のうち選択外の部分です。</p>
        <div id="plots" class="plots"></div>
      </section>

      <section id="stats-card" class="card" hidden>
        <div class="card-head">
          <h2>要約統計量</h2>
          <span id="statsScope" class="status muted"></span>
        </div>
        <div id="statsTable" class="table-scroll"></div>
      </section>
    </div>
  </main>
`;

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;

const dropzoneEl = $<HTMLDivElement>('#dropzone');
const fileInputEl = $<HTMLInputElement>('#fileInput');
const sampleButtonEl = $<HTMLButtonElement>('#sampleButton');
const uploadStatusEl = $<HTMLDivElement>('#uploadStatus');
const previewDetailsEl = $<HTMLDetailsElement>('#previewDetails');
const previewTableEl = $<HTMLTableElement>('#previewTable');
const uploadResultEl = $<HTMLDivElement>('#uploadResult');

const viewSectionEl = $<HTMLElement>('#view-section');
const xAxisSelectEl = $<HTMLSelectElement>('#xAxisSelect');
const yAxisSelectEl = $<HTMLSelectElement>('#yAxisSelect');
const colorSelectEl = $<HTMLSelectElement>('#colorSelect');
const filterSectionEl = $<HTMLElement>('#filter-section');
const filterResetEl = $<HTMLButtonElement>('#filterReset');
const filterMissingNoteEl = $<HTMLDivElement>('#filterMissingNote');
const filterExclusionNoteEl = $<HTMLDivElement>('#filterExclusionNote');
const filterPanelEl = $<HTMLDivElement>('#filterPanel');

const emptyStateEl = $<HTMLElement>('#emptyState');
const countTilesEl = $<HTMLElement>('#countTiles');
const selectedCountEl = $<HTMLDivElement>('#selectedCount');
const selectedRateEl = $<HTMLDivElement>('#selectedRate');
const populationCountEl = $<HTMLDivElement>('#populationCount');
const populationRateEl = $<HTMLDivElement>('#populationRate');
const totalCountEl = $<HTMLDivElement>('#totalCount');
const totalSubEl = $<HTMLDivElement>('#totalSub');
const populationBarEl = $<HTMLDivElement>('#populationBar');
const selectedBarEl = $<HTMLDivElement>('#selectedBar');
const chartCardEl = $<HTMLElement>('#chart-card');
const chartStatusEl = $<HTMLSpanElement>('#chartStatus');
const chartHintEl = $<HTMLParagraphElement>('#chartHint');
const plotsEl = $<HTMLDivElement>('#plots');
const statsCardEl = $<HTMLElement>('#stats-card');
const statsScopeEl = $<HTMLSpanElement>('#statsScope');
const statsTableEl = $<HTMLDivElement>('#statsTable');

function setUploadStatus(message: string, kind: 'info' | 'ok' | 'error') {
  uploadStatusEl.textContent = message;
  uploadStatusEl.dataset.kind = kind;
}

function setChartStatus(message: string, isError: boolean) {
  chartStatusEl.textContent = message;
  chartStatusEl.classList.toggle('error', isError);
}

// アップロードされたファイルの中身（セル値・列名）をそのまま innerHTML に
// 差し込むため、HTML として解釈されないようにエスケープする。
function escapeHtml(value: string): string {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

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
 * フィルタパネルの先頭に注記として出す。列ごとに欠測件数も添えて、
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
 * 件数タイルと統計表を更新する。stats.ts の2つのクライアント
 * （選択中・母集団）のどちらかが結果を返すたびに呼ばれる。
 *
 * 件数は「選択中 ⊂ 母集団 ⊂ 全体」の入れ子なので、比率も入れ子で出す
 * （選択中は母集団に対する割合、母集団は全体に対する割合）。
 * 下の帯グラフでも同じ入れ子を幅で表し、数字を読まなくても
 * 「どれだけ絞って、その中のどれだけを選んだか」が分かるようにする。
 */
function renderCountsAndStats(
  totalRows: number,
  numericCols: string[],
  selected: StatsSnapshot | null,
  population: StatsSnapshot | null
) {
  if (population) {
    populationCountEl.textContent = population.rows.toLocaleString();
    populationRateEl.textContent =
      population.rows === totalRows ? 'フィルタなし（全体と同じ）' : `全体の ${percent(population.rows, totalRows)}`;
    populationBarEl.style.width = `${(population.rows / totalRows) * 100}%`;
  }
  if (selected) {
    selectedCountEl.textContent = selected.rows.toLocaleString();
    selectedBarEl.style.width = `${(selected.rows / totalRows) * 100}%`;
  }
  if (selected && population) {
    const noSelection = selected.rows === population.rows;
    selectedRateEl.textContent = noSelection
      ? '未選択（母集団すべて）'
      : `母集団の ${percent(selected.rows, population.rows)}`;
    countTilesEl.classList.toggle('has-selection', !noSelection);
    statsScopeEl.textContent = noSelection
      ? '母集団すべてを集計中。チャートで範囲を選ぶと、選択中の値と母集団との差が出ます'
      : `選択中の ${selected.rows.toLocaleString()} 件を集計`;
    if (numericCols.length > 0) renderStatsTable(statsTableEl, numericCols, selected, population);
  }
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

/**
 * アップロード成功後、軸選択・フィルタパネル・散布図/ヒストグラム・統計量を
 * 組み立てる。
 *
 * 別ファイルを読み込むたびに呼ばれる。$filter・$brush は毎回新しく作り直し、
 * 古い列に対する条件が新しいテーブルに引き継がれないようにする。
 * db.clear() で古いチャート・集計クライアントも切断する
 * （フィルタ用ウィジェット自体は MosaicClient として登録していないため
 * 影響を受けない）。
 */
// 散布図の名前に付ける連番。凡例は名前で散布図を引くため、別ファイルを
// 読み込んだ後も含めて一意にする（重複すると vgplot が古い図を上書きする）
let plotSerial = 0;

async function setupChartsAndFilters(db: Coordinator, table: LoadedTable) {
  emptyStateEl.hidden = true;
  chartCardEl.hidden = false;
  setChartStatus('列を調べています…', false);
  countTilesEl.hidden = true;
  statsCardEl.hidden = true;
  viewSectionEl.hidden = true;
  filterSectionEl.hidden = true;
  filterMissingNoteEl.textContent = '';
  filterExclusionNoteEl.textContent = '';
  filterPanelEl.innerHTML = '';
  plotsEl.innerHTML = '';
  statsTableEl.innerHTML = '';

  db.clear(); // 古いチャート・集計クライアントを切断する（既定で clients・cache とも true）

  let cols;
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
    filterExclusionNoteEl.textContent = `種類が多すぎる列はフィルタ・色分けから除外: ${detail}`;
  }

  const $filter = newFilterSelection();
  const $brush = Selection.crossfilter({ include: [$filter] });

  let panel: FilterPanel;
  try {
    panel = await buildFilterPanel(db, table.tableName, cols, $filter, renderMissingIncludedNote);
    filterPanelEl.appendChild(panel.element);
  } catch (e) {
    setChartStatus(`⚠️ フィルタパネルの構築に失敗しました: ${e instanceof Error ? e.message : String(e)}`, true);
    return;
  }
  // 別ファイル読み込み時に古いパネルの reset が残らないよう、onclick で上書きする
  filterResetEl.onclick = () => panel.reset();
  filterSectionEl.hidden = false;

  totalCountEl.textContent = table.rowCount.toLocaleString();
  totalSubEl.textContent = `${table.columns.length} 列（数値 ${cols.numericCols.length}）`;
  countTilesEl.hidden = false;
  statsCardEl.hidden = cols.numericCols.length === 0;

  const connectStats = () =>
    connectStatsClients(db, table.tableName, cols.numericCols, $filter, $brush, (sel, pop) =>
      renderCountsAndStats(table.rowCount, cols.numericCols, sel, pop)
    );

  if (cols.numericCols.length < 2) {
    connectStats();
    plotsEl.innerHTML = '';
    setChartStatus('散布図を描くには数値列が2つ以上必要です（フィルタと統計量は利用できます）。', false);
    return;
  }

  let x: string, y: string;
  try {
    [x, y] = await pickBestAxisPair(db, table.tableName, cols.numericCols);
  } catch (e) {
    setChartStatus(`⚠️ 軸の自動選択に失敗しました: ${e instanceof Error ? e.message : String(e)}`, true);
    return;
  }

  const numericOptions = cols.numericCols.map((c) => ({ value: c, label: c }));
  populateSelect(xAxisSelectEl, numericOptions, x);
  populateSelect(yAxisSelectEl, numericOptions, y);
  // 色分けの初期値は最初のカテゴリ列（自動で組み立てる）。「なし」も選べる。
  // raster 描画のときは色分けできないため、セレクタごと無効にして理由を出す
  const useRaster = table.rowCount >= DOT_TO_RASTER_THRESHOLD;
  populateSelect(
    colorSelectEl,
    [{ value: '', label: '（なし）' }, ...cols.catCols.map((c) => ({ value: c, label: c }))],
    useRaster ? '' : (cols.catCols[0] ?? '')
  );
  colorSelectEl.disabled = useRaster || cols.catCols.length === 0;
  colorSelectEl.title = useRaster
    ? `行数が ${DOT_TO_RASTER_THRESHOLD.toLocaleString()} 件以上のため密度表示（raster）になり、色分けできません`
    : '';
  viewSectionEl.hidden = false;

  function rebuildCharts() {
    db.clear(); // 軸を変えるたびに、直前のチャート・集計クライアントを切断する
    plotsEl.innerHTML = '';

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
      plotName,
      width: sizes.scatter,
      height: Math.round(Math.min(sizes.scatter * 0.75, 460)),
    });
    const histSize = { width: sizes.hist, height: 190 };
    const histX = buildHistogram(table.tableName, xCol, $filter, $brush, histSize);
    const histY = buildHistogram(table.tableName, yCol, $filter, $brush, histSize);

    const scatterWrap = document.createElement('div');
    scatterWrap.className = 'plot-main';
    if (colorCol) scatterWrap.appendChild(buildColorLegend(plotName));
    scatterWrap.appendChild(scatter);
    const side = document.createElement('div');
    side.className = 'plot-side';
    side.append(histX, histY);
    plotsEl.append(scatterWrap, side);

    connectStats();

    // raster の散布図は1層だけ（charts.ts 参照）なので、灰色の背景は出ない。
    // 説明文と見た目が食い違わないよう、そのときだけ一言添える
    chartHintEl.textContent =
      'ドラッグで範囲を選択（マーキング）。何もない所をクリックすると選択を解除します。灰色は母集団のうち選択外の部分です。' +
      (useRaster ? '（密度表示の散布図には選択外は表示されません）' : '');

    setChartStatus(
      `${useRaster ? '密度表示（raster）' : '点表示（dot）'}・${table.rowCount.toLocaleString()} 行`,
      false
    );
  }

  // 別ファイルを読み込むたびにリスナーが積み重ならないよう、addEventListener
  // ではなく onchange で上書きする（積み重なると1回の変更でチャートが
  // 読み込んだファイル数だけ作り直され、古いテーブルの列名で描こうとする）
  xAxisSelectEl.onchange = rebuildCharts;
  yAxisSelectEl.onchange = rebuildCharts;
  colorSelectEl.onchange = rebuildCharts;

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

      await setupChartsAndFilters(db, table);
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

  fileInputEl.addEventListener('change', () => {
    const file = fileInputEl.files?.[0];
    if (file) handleFile(file);
    fileInputEl.value = ''; // 同じファイルを選び直しても change が発火するように
  });

  sampleButtonEl.addEventListener('click', () => {
    previewDetailsEl.open = false;
    handleRows(SAMPLE_FILE_NAME, generateSampleRows()).catch(showError);
  });

  dropzoneEl.addEventListener('click', () => fileInputEl.click());
  dropzoneEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInputEl.click();
    }
  });

  dropzoneEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzoneEl.classList.add('dragover');
  });
  dropzoneEl.addEventListener('dragleave', () => {
    dropzoneEl.classList.remove('dragover');
  });
  dropzoneEl.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzoneEl.classList.remove('dragover');
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });

  // DuckDB の初期化が済むまではドロップ領域を無効にしてある。ここで有効化する
  dropzoneEl.classList.remove('disabled');
  dropzoneEl.removeAttribute('aria-disabled');
  sampleButtonEl.disabled = false;
  setUploadStatus('', 'info');
}

async function main() {
  setUploadStatus('DuckDB-WASM を初期化中…', 'info');
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
