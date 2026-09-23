// Brushlink Web版。
//
// CLAUDE.md「次にやること」1（ファイル読み込み）・2（軸選択とフィルタパネル）。
// 検証用に使っていた合成データの 'points' テーブルはもう使わない。
// 散布図の対象は、画面からアップロードしたテーブル（'uploaded'）にする。

import './style.css';
import { makeClient } from '@uwdata/mosaic-core';
import { DuckDBWASMConnector, coordinator, Selection, Query, count } from '@uwdata/vgplot';
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
import type { MissingIncludedEntry } from './filters';
import { pickBestAxisPair, buildScatterPlot, buildHistogram, DOT_TO_RASTER_THRESHOLD } from './charts';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <h1>Brushlink — Web 版</h1>

  <section id="upload-section">
    <h2>ファイル読み込み</h2>
    <div id="dropzone" tabindex="0" class="disabled">
      DuckDB-WASM を初期化中…
    </div>
    <input type="file" id="fileInput" accept=".csv,.xlsx,.xls" hidden />
    <div id="uploadStatus"></div>
    <p id="previewHint" hidden>
      先頭数行のプレビュー。ヘッダにする行をクリックして選ぶ
      （自動推定した行を初期選択にしてある）。
    </p>
    <table id="previewTable"></table>
    <div id="uploadResult"></div>
  </section>

  <section id="chart-section">
    <h2>散布図</h2>
    <div id="axisControls" hidden>
      <label>X軸 <select id="xAxisSelect"></select></label>
      <label>Y軸 <select id="yAxisSelect"></select></label>
    </div>
    <div id="chartStatus"></div>
    <p id="countLine" hidden>
      選択中: <span id="selectedCount">-</span> /
      母集団: <span id="populationCount">-</span> /
      全体: <span id="totalCount">-</span> 件
    </p>
    <div id="filterMissingNote"></div>
    <div id="filterExclusionNote"></div>
    <div id="filterPanel"></div>
    <div id="plots"></div>
  </section>
`;

const dropzoneEl = document.querySelector<HTMLDivElement>('#dropzone')!;
const fileInputEl = document.querySelector<HTMLInputElement>('#fileInput')!;
const uploadStatusEl = document.querySelector<HTMLDivElement>('#uploadStatus')!;
const previewHintEl = document.querySelector<HTMLParagraphElement>('#previewHint')!;
const previewTableEl = document.querySelector<HTMLTableElement>('#previewTable')!;
const uploadResultEl = document.querySelector<HTMLDivElement>('#uploadResult')!;

const axisControlsEl = document.querySelector<HTMLDivElement>('#axisControls')!;
const xAxisSelectEl = document.querySelector<HTMLSelectElement>('#xAxisSelect')!;
const yAxisSelectEl = document.querySelector<HTMLSelectElement>('#yAxisSelect')!;
const chartStatusEl = document.querySelector<HTMLDivElement>('#chartStatus')!;
const countLineEl = document.querySelector<HTMLParagraphElement>('#countLine')!;
const selectedCountEl = document.querySelector<HTMLSpanElement>('#selectedCount')!;
const populationCountEl = document.querySelector<HTMLSpanElement>('#populationCount')!;
const totalCountEl = document.querySelector<HTMLSpanElement>('#totalCount')!;
const filterMissingNoteEl = document.querySelector<HTMLDivElement>('#filterMissingNote')!;
const filterExclusionNoteEl = document.querySelector<HTMLDivElement>('#filterExclusionNote')!;
const filterPanelEl = document.querySelector<HTMLDivElement>('#filterPanel')!;
const plotsEl = document.querySelector<HTMLDivElement>('#plots')!;

function setUploadStatus(message: string, isError: boolean) {
  uploadStatusEl.textContent = message;
  uploadStatusEl.style.color = isError ? 'crimson' : 'inherit';
}

function setChartStatus(message: string, isError: boolean) {
  chartStatusEl.textContent = message;
  chartStatusEl.style.color = isError ? 'crimson' : 'inherit';
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
 */
function renderPreview(
  rows: unknown[][],
  headerRow: number,
  onSelect: (row: number) => void
) {
  const rowsToShow = previewRows(rows);
  const maxCols = Math.max(...rowsToShow.map((r) => r.length), 1);

  const thead = `
    <thead><tr><th>ヘッダにする</th>${Array.from({ length: maxCols }, (_, i) => `<th>列${i}</th>`).join('')}</tr></thead>
  `;
  const tbody = rowsToShow
    .map((row, i) => {
      const cells = Array.from({ length: maxCols }, (_, c) => {
        const v = row[c];
        return `<td>${v === null || v === undefined ? '' : escapeHtml(String(v))}</td>`;
      }).join('');
      const checked = i === headerRow ? 'checked' : '';
      return `<tr><td><input type="radio" name="headerRowChoice" value="${i}" ${checked}></td>${cells}</tr>`;
    })
    .join('');

  previewTableEl.innerHTML = thead + `<tbody>${tbody}</tbody>`;
  previewHintEl.hidden = false;

  previewTableEl.querySelectorAll<HTMLInputElement>('input[name="headerRowChoice"]').forEach((input) => {
    input.addEventListener('change', () => onSelect(Number(input.value)));
  });
}

/**
 * 「欠測を含める」チェックボックスが現在オンになっている列の一覧を、
 * 件数表示のすぐ下に注記として出す。列ごとに欠測件数も添えて、
 * どれだけの行がレンジ・チェックボックスの条件をすり抜けて通っているかが
 * 見えるようにする。
 */
function renderMissingIncludedNote(entries: MissingIncludedEntry[]) {
  if (entries.length === 0) {
    filterMissingNoteEl.textContent = '';
    return;
  }
  const detail = entries
    .map((e) => `${e.column}（${e.nullCount.toLocaleString()}件）`)
    .join('、');
  filterMissingNoteEl.textContent = `ℹ️ 欠測を含めているフィルタ: ${detail}`;
}

function populateAxisSelect(select: HTMLSelectElement, cols: string[], selected: string) {
  select.innerHTML = cols
    .map((c) => `<option value="${escapeHtml(c)}" ${c === selected ? 'selected' : ''}>${escapeHtml(c)}</option>`)
    .join('');
}

/**
 * アップロード成功後、軸選択・フィルタパネル・散布図/ヒストグラムを組み立てる。
 *
 * 別ファイルを読み込むたびに呼ばれる。$filter・$brush は毎回新しく作り直し、
 * 古い列に対する条件が新しいテーブルに引き継がれないようにする。
 * db.clear() で古い散布図・ヒストグラム・件数表示クライアントも切断する
 * （フィルタ用ウィジェット自体は MosaicClient として登録していないため
 * 影響を受けない。$filter Selection オブジェクトはこの関数のクロージャに
 * 閉じているだけで、切断の対象にはならない）。
 */
function connectCountClients(
  db: Coordinator,
  tableName: string,
  $filter: Selection,
  $brush: Selection
) {
  makeClient({
    coordinator: db,
    selection: $filter,
    query: (filter) => Query.from(tableName).select({ n: count() }).where(filter),
    queryResult: (data: any) => {
      populationCountEl.textContent = Number(data.get(0).n).toLocaleString();
    },
  });
  makeClient({
    coordinator: db,
    selection: $brush,
    query: (filter) => Query.from(tableName).select({ n: count() }).where(filter),
    queryResult: (data: any) => {
      selectedCountEl.textContent = Number(data.get(0).n).toLocaleString();
    },
  });
}

async function setupChartsAndFilters(db: Coordinator, table: LoadedTable) {
  setChartStatus('列を調べています…', false);
  countLineEl.hidden = true;
  axisControlsEl.hidden = true;
  filterMissingNoteEl.textContent = '';
  filterExclusionNoteEl.textContent = '';
  filterPanelEl.innerHTML = '';
  plotsEl.innerHTML = '';

  db.clear(); // 古いチャート・件数クライアントを切断する（既定で clients・cache とも true）

  let cols;
  try {
    cols = await classifyColumns(db, table.tableName, table.columns);
  } catch (e) {
    setChartStatus(
      `⚠️ 列の分類に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
      true
    );
    return;
  }

  if (cols.highCardCols.length > 0) {
    const detail = cols.highCardCols
      .map((c) => `${escapeHtml(c.name)}（${c.cardinality.toLocaleString()}種）`)
      .join('、');
    filterExclusionNoteEl.textContent = `⚠️ 高カーディナリティ列をフィルタ・色分けから除外: ${detail}`;
  }

  const $filter = newFilterSelection();
  const $brush = Selection.crossfilter({ include: [$filter] });

  try {
    const panel = await buildFilterPanel(db, table.tableName, cols, $filter, renderMissingIncludedNote);
    filterPanelEl.appendChild(panel.element);
  } catch (e) {
    setChartStatus(
      `⚠️ フィルタパネルの構築に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
      true
    );
    return;
  }

  totalCountEl.textContent = table.rowCount.toLocaleString();
  countLineEl.hidden = false;

  if (cols.numericCols.length < 2) {
    connectCountClients(db, table.tableName, $filter, $brush);
    setChartStatus('散布図を描くには数値列が2つ以上必要です（フィルタのみ利用できます）。', false);
    return;
  }

  let x: string, y: string;
  try {
    [x, y] = await pickBestAxisPair(db, table.tableName, cols.numericCols);
  } catch (e) {
    setChartStatus(
      `⚠️ 軸の自動選択に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
      true
    );
    return;
  }

  populateAxisSelect(xAxisSelectEl, cols.numericCols, x);
  populateAxisSelect(yAxisSelectEl, cols.numericCols, y);
  axisControlsEl.hidden = false;

  const colorCol = cols.catCols[0] ?? null;
  const useRaster = table.rowCount >= DOT_TO_RASTER_THRESHOLD;

  function rebuildScatterAndHist() {
    db.clear(); // 軸を変えるたびに、直前の散布図・ヒストグラム・件数クライアントを切断する
    plotsEl.innerHTML = '';

    const xCol = xAxisSelectEl.value;
    const yCol = yAxisSelectEl.value;

    const scatter = buildScatterPlot({
      tableName: table.tableName,
      x: xCol,
      y: yCol,
      colorCol,
      rowCount: table.rowCount,
      filterBy: $brush,
    });
    const hist = buildHistogram(table.tableName, xCol, $brush);
    plotsEl.append(scatter, hist);

    connectCountClients(db, table.tableName, $filter, $brush);

    setChartStatus(
      `散布図: X=${xCol} / Y=${yCol}（${useRaster ? 'raster' : 'dot'} で描画、行数 ${table.rowCount.toLocaleString()}）`,
      false
    );
  }

  xAxisSelectEl.addEventListener('change', rebuildScatterAndHist);
  yAxisSelectEl.addEventListener('change', rebuildScatterAndHist);

  rebuildScatterAndHist();
}

/**
 * ドロップ領域・ファイル選択・ヘッダ行クリックの一連を配線する。
 *
 * 読み込みトリガーは常に「プレビュー表の行クリック」に一本化してある
 * （Python版と同じ設計）。ファイルを受け取った直後は自動推定した行で
 * 一度読み込みを試みるが、それも `loadWithHeaderRow` を呼ぶだけで、
 * ユーザーが後から別の行をクリックした場合と同じ経路を通る。
 */
function setupUpload(db: Coordinator, duckdb: duckdbWasm.AsyncDuckDB) {
  let currentRows: unknown[][] | null = null;
  let currentFileName = '';

  function showError(e: unknown) {
    const message =
      e instanceof UploadError
        ? e.message
        : `予期しないエラーが発生しました: ${e instanceof Error ? e.message : String(e)}`;
    setUploadStatus(`⚠️ ${message}`, true);
    uploadResultEl.innerHTML = '';
  }

  async function loadWithHeaderRow(headerRow: number) {
    if (!currentRows) return;
    setUploadStatus(`「${currentFileName}」を読み込み中…（ヘッダ行: ${headerRow}）`, false);
    uploadResultEl.innerHTML = '';

    try {
      const csvText = rowsToCsv(currentRows, headerRow);
      const table = await registerCsvTable(duckdb, db, 'uploaded', csvText);
      setUploadStatus(
        `✅「${currentFileName}」を読み込みました（${table.rowCount.toLocaleString()} 行、テーブル名: ${table.tableName}）`,
        false
      );
      const columnRows = table.columns
        .map((c) => `<tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.type)}</td></tr>`)
        .join('');
      uploadResultEl.innerHTML = `
        <table><thead><tr><th>列名</th><th>DuckDBの型</th></tr></thead><tbody>${columnRows}</tbody></table>
      `;

      await setupChartsAndFilters(db, table);
    } catch (e) {
      showError(e);
    }
  }

  async function handleFile(file: File) {
    setUploadStatus(`「${file.name}」を解析中…`, false);
    uploadResultEl.innerHTML = '';
    previewTableEl.innerHTML = '';
    previewHintEl.hidden = true;
    currentFileName = file.name;
    currentRows = null;

    try {
      const rows = await parseRaw(file);
      currentRows = rows;
      const guess = guessHeaderRow(rows);
      renderPreview(rows, guess, (row) => {
        loadWithHeaderRow(row);
      });
      await loadWithHeaderRow(guess);
    } catch (e) {
      showError(e);
    }
  }

  fileInputEl.addEventListener('change', () => {
    const file = fileInputEl.files?.[0];
    if (file) handleFile(file);
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
}

async function main() {
  const connector = new DuckDBWASMConnector();
  const db = coordinator();
  db.databaseConnector(connector);
  const duckdb = await connector.getDuckDB();

  setupUpload(db, duckdb);
}

main().catch((err) => {
  console.error(err);
  setUploadStatus(`⚠️ 初期化に失敗しました: ${err instanceof Error ? err.message : String(err)}`, true);
});
