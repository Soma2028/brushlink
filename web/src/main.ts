// ブラウザ内完結版の技術検証（Vite + TypeScript）。
// 確認する3点:
//   1. DuckDB-WASM の初期化 + CSV 読み込み + SELECT
//   2. Mosaic での散布図・ヒストグラムの範囲選択連動
//   3. 選択された行数の表示
// 加えて、データ量を増やしたときの限界を計測する（行数は ?n= で切り替え）:
//   - CSV を DuckDB-WASM に登録し終わるまでの時間
//   - 初回の散布図描画にかかる時間
//   - ドラッグ選択に対する件数更新の応答時間（driver 側で計測、ここは時刻を晒すだけ）
//   - ブラウザのメモリ使用量（performance.memory、Chrome 限定の概算値）
// 見た目・UI の作り込み・統計機能・Excel 対応はしない。行数切り替えも
// URL パラメータのみで、専用 UI は作らない。

import './style.css';
import { makeClient } from '@uwdata/mosaic-core';
import {
  DuckDBWASMConnector,
  coordinator,
  Selection,
  Query,
  count,
  bin,
  from,
  plot,
  dot,
  rectY,
  raster,
  hexbin,
  intervalX,
  intervalXY,
  loadCSV,
  width,
  height,
} from '@uwdata/vgplot';
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

type MarkKind = 'dot' | 'raster' | 'hexbin';

// --- 計測結果。Playwright など外部の driver から読めるよう window に生やす ---
interface Metrics {
  n: number;
  genMs: number | null;
  loadMs: number | null;
  markKind: MarkKind;
  firstRenderMs: number | null;
  scatterDomNodes: number | null;
  memBaselineBytes: number | null;
  memAfterLoadBytes: number | null;
  memAfterRenderBytes: number | null;
  // ドラッグ選択の応答時間は driver 側が計測する。ここでは
  // 「選択結果が反映された時刻」を performance.now() で晒すだけ
  // （page/driver 間の時計ずれを避けるため、両方とも page 内の
  // performance.now() で揃える）。
  lastSelectionAppliedAt: number | null;
}

const metrics: Metrics = {
  n: 0,
  genMs: null,
  loadMs: null,
  markKind: 'dot',
  firstRenderMs: null,
  scatterDomNodes: null,
  memBaselineBytes: memSnapshot(),
  memAfterLoadBytes: null,
  memAfterRenderBytes: null,
  lastSelectionAppliedAt: null,
};
(window as any).__metrics = metrics;

function memSnapshot(): number | null {
  const m = (performance as any).memory;
  return m ? m.usedJSHeapSize : null;
}

function getRowCountFromUrl(): number {
  const raw = new URLSearchParams(location.search).get('n');
  const n = raw ? Number(raw) : 300;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 300;
}

// dot（1点=1DOMノード）と、DuckDB 側で集計してから描く raster / hexbin を
// 切り替えて比較する。専用 UI は作らず ?mark= のみで切り替える。
function getMarkKindFromUrl(): MarkKind {
  const raw = new URLSearchParams(location.search).get('mark');
  return raw === 'raster' || raw === 'hexbin' ? raw : 'dot';
}

// 散布図側に使うマーク本体を組み立てる。dot 以外は DuckDB 側で
// グリッド/ヘキサゴン単位に集計してから描画するため、DOM ノード数が
// 行数から切り離されることを比較したい。
function buildScatterMark(kind: MarkKind, filterBy: ReturnType<typeof Selection.crossfilter>) {
  const source = from('points', { filterBy });
  switch (kind) {
    case 'raster':
      return raster(source, { x: 'x', y: 'y' });
    case 'hexbin':
      return hexbin(source, { x: 'x', y: 'y', fill: count(), binWidth: 10 });
    case 'dot':
    default:
      return dot(source, { x: 'x', y: 'y', fill: 'group' });
  }
}

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <h1>Brushlink — Web 版</h1>

  <section id="upload-section">
    <h2>ファイル読み込み</h2>
    <div id="dropzone" tabindex="0">
      ここに CSV / Excel(.xlsx) をドラッグ＆ドロップ、またはクリックして選択
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

  <section id="demo-section">
    <h2>技術検証（データ量の限界計測）</h2>
    <p>行数・マーク種別は URL パラメータで切り替える
       （例: <code>?n=1000000&amp;mark=raster</code>）。既定は 300 行 / dot。
       mark は dot / raster / hexbin。</p>
    <div id="status"></div>
    <p>選択中: <span id="count">-</span></p>
    <div id="plots"></div>
  </section>
`;

const statusEl = document.querySelector<HTMLDivElement>('#status')!;
const countEl = document.querySelector<HTMLSpanElement>('#count')!;
const plotsEl = document.querySelector<HTMLDivElement>('#plots')!;

function log(line: string) {
  console.log(line);
  statusEl.textContent += (statusEl.textContent ? '\n' : '') + line;
}

const dropzoneEl = document.querySelector<HTMLDivElement>('#dropzone')!;
const fileInputEl = document.querySelector<HTMLInputElement>('#fileInput')!;
const uploadStatusEl = document.querySelector<HTMLDivElement>('#uploadStatus')!;
const previewHintEl = document.querySelector<HTMLParagraphElement>('#previewHint')!;
const previewTableEl = document.querySelector<HTMLTableElement>('#previewTable')!;
const uploadResultEl = document.querySelector<HTMLDivElement>('#uploadResult')!;

function setUploadStatus(message: string, isError: boolean) {
  uploadStatusEl.textContent = message;
  uploadStatusEl.style.color = isError ? 'crimson' : 'inherit';
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

// --- サンプル CSV をその場で生成する（外部ファイル取得を経路から外し、
//     「DuckDB-WASM への登録そのもの」の時間だけを計測できるようにする） ---
function makeSampleCsv(n: number): { csv: string; genMs: number } {
  const t0 = performance.now();
  const rows = new Array<string>(n + 1);
  rows[0] = 'x,y,group';
  for (let i = 0; i < n; i++) {
    const group = i % 3 === 0 ? 'A' : i % 3 === 1 ? 'B' : 'C';
    const x = Math.round((Math.random() * 100 + (group === 'A' ? 20 : 0)) * 100) / 100;
    const y = Math.round((x * 0.6 + Math.random() * 30) * 100) / 100;
    rows[i + 1] = `${x},${y},${group}`;
  }
  const csv = rows.join('\n');
  return { csv, genMs: performance.now() - t0 };
}

// 対象要素の中に最初の <svg> が現れるまでの時間を計る（初回描画の完了とみなす）。
function waitForFirstSvg(target: Element, timeoutMs = 180_000): Promise<number> {
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    if (target.querySelector('svg')) {
      resolve(performance.now() - t0);
      return;
    }
    const timer = setTimeout(() => {
      obs.disconnect();
      reject(new Error(`初回描画が ${timeoutMs}ms 以内に終わりませんでした`));
    }, timeoutMs);
    const obs = new MutationObserver(() => {
      if (target.querySelector('svg')) {
        clearTimeout(timer);
        obs.disconnect();
        resolve(performance.now() - t0);
      }
    });
    obs.observe(target, { childList: true, subtree: true });
  });
}

async function main() {
  const n = getRowCountFromUrl();
  const markKind = getMarkKindFromUrl();
  metrics.n = n;
  metrics.markKind = markKind;
  log(`行数: ${n.toLocaleString()} / マーク: ${markKind}`);

  // --- 1. DuckDB-WASM の初期化 + CSV 読み込み + SELECT -------------------
  log('[1] DuckDB-WASM を初期化中…');
  const connector = new DuckDBWASMConnector();
  const db = coordinator();
  db.databaseConnector(connector);
  await connector.getDuckDB(); // ここで WASM 本体の初期化を先に済ませておく

  const { csv: csvText, genMs } = makeSampleCsv(n);
  metrics.genMs = genMs;
  log(`[計測] CSV生成(JS側、参考値): ${genMs.toFixed(1)} ms`);

  const duckdb = await connector.getDuckDB();

  setupUpload(db, duckdb);

  const tLoad0 = performance.now();
  await duckdb.registerFileText('points.csv', csvText);
  await db.exec(loadCSV('points', 'points.csv'));
  const loadMs = performance.now() - tLoad0;
  metrics.loadMs = loadMs;
  metrics.memAfterLoadBytes = memSnapshot();
  log(`[計測] DuckDB-WASM への登録: ${loadMs.toFixed(1)} ms`);

  const countRows: any = await db.query(
    Query.from('points').select({ n: count() })
  );
  const totalRows = Number(countRows.get(0).n);
  log(`[1] OK: SELECT COUNT(*) FROM points -> ${totalRows} 行`);

  // --- 2. 散布図 + ヒストグラムを、共有 Selection で範囲選択連動させる -----
  log(`[2] 散布図（${markKind}）・ヒストグラムを描画し、範囲選択を連動させます…`);
  const $brush = Selection.crossfilter();

  const scatter = plot(
    buildScatterMark(markKind, $brush),
    intervalXY({ as: $brush }),
    width(360),
    height(300)
  );

  const hist = plot(
    rectY(from('points', { filterBy: $brush }), {
      x: bin('x'),
      y: count(),
      fill: 'steelblue',
    }),
    intervalX({ as: $brush }),
    width(360),
    height(300)
  );

  const firstRenderPromise = waitForFirstSvg(scatter);
  plotsEl.appendChild(scatter);
  plotsEl.appendChild(hist);

  try {
    const firstRenderMs = await firstRenderPromise;
    metrics.firstRenderMs = firstRenderMs;
    metrics.scatterDomNodes = scatter.querySelectorAll('*').length;
    metrics.memAfterRenderBytes = memSnapshot();
    log(`[計測] 初回の散布図描画: ${firstRenderMs.toFixed(1)} ms`);
    log(`[計測] 散布図のDOMノード数: ${metrics.scatterDomNodes.toLocaleString()}`);
    log('[2] OK: 散布図・ヒストグラムを描画しました（ドラッグで範囲選択を確認）');
  } catch (e) {
    log(`[2] ✗ 初回描画がタイムアウトしました: ${e instanceof Error ? e.message : e}`);
    metrics.memAfterRenderBytes = memSnapshot();
  }

  // --- 3. 選択された行数を画面に表示する ----------------------------------
  makeClient({
    coordinator: db,
    selection: $brush,
    query: (filter) => Query.from('points').select({ n: count() }).where(filter),
    queryResult: (data: any) => {
      const selected = Number(data.get(0).n);
      countEl.textContent = `${selected} / ${totalRows} 行`;
      metrics.lastSelectionAppliedAt = performance.now();
    },
  });
  log('[3] OK: 選択行数の表示クライアントを接続しました');
  log('=== READY ===');
}

main().catch((err) => {
  console.error(err);
  log(`✗ エラー: ${err instanceof Error ? err.message : String(err)}`);
});
