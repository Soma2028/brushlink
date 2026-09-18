// ブラウザ内完結版の技術検証（Vite + TypeScript）。
// 確認する3点だけに絞る:
//   1. DuckDB-WASM の初期化 + CSV 読み込み + SELECT
//   2. Mosaic での散布図・ヒストグラムの範囲選択連動
//   3. 選択された行数の表示
// 見た目・UI の作り込み・統計機能・Excel 対応はしない。

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
  intervalX,
  intervalXY,
  loadCSV,
  width,
  height,
} from '@uwdata/vgplot';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <h1>Brushlink — Web 版 技術検証</h1>
  <p>DuckDB-WASM + Mosaic (vgplot) が動くかだけを確認する最小構成。</p>
  <div id="status"></div>
  <p>選択中: <span id="count">-</span></p>
  <div id="plots"></div>
`;

const statusEl = document.querySelector<HTMLDivElement>('#status')!;
const countEl = document.querySelector<HTMLSpanElement>('#count')!;
const plotsEl = document.querySelector<HTMLDivElement>('#plots')!;

function log(line: string) {
  console.log(line);
  statusEl.textContent += (statusEl.textContent ? '\n' : '') + line;
}

// --- サンプル CSV をその場で生成する（外部ファイル取得を経路から外し、
//     まず「DuckDB-WASM の初期化と SELECT が通るか」だけを最短で確認する） ---
function makeSampleCsv(n = 300): string {
  const rows = ['x,y,group'];
  for (let i = 0; i < n; i++) {
    const group = i % 3 === 0 ? 'A' : i % 3 === 1 ? 'B' : 'C';
    const x = Math.round((Math.random() * 100 + (group === 'A' ? 20 : 0)) * 100) / 100;
    const y = Math.round((x * 0.6 + Math.random() * 30) * 100) / 100;
    rows.push(`${x},${y},${group}`);
  }
  return rows.join('\n');
}

async function main() {
  // --- 1. DuckDB-WASM の初期化 + CSV 読み込み + SELECT -------------------
  log('[1] DuckDB-WASM を初期化中…');
  const connector = new DuckDBWASMConnector();
  const db = coordinator();
  db.databaseConnector(connector);

  const duckdb = await connector.getDuckDB();
  const csvText = makeSampleCsv();
  await duckdb.registerFileText('points.csv', csvText);
  await db.exec(loadCSV('points', 'points.csv'));

  const countRows: any = await db.query(
    Query.from('points').select({ n: count() })
  );
  const totalRows = Number(countRows.get(0).n);
  log(`[1] OK: SELECT COUNT(*) FROM points -> ${totalRows} 行`);

  // --- 2. 散布図 + ヒストグラムを、共有 Selection で範囲選択連動させる -----
  log('[2] 散布図・ヒストグラムを描画し、範囲選択を連動させます…');
  const $brush = Selection.crossfilter();

  const scatter = plot(
    dot(from('points', { filterBy: $brush }), { x: 'x', y: 'y', fill: 'group' }),
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

  plotsEl.appendChild(scatter);
  plotsEl.appendChild(hist);
  log('[2] OK: 散布図・ヒストグラムを描画しました（ドラッグで範囲選択を確認）');

  // --- 3. 選択された行数を画面に表示する ----------------------------------
  makeClient({
    coordinator: db,
    selection: $brush,
    query: (filter) => Query.from('points').select({ n: count() }).where(filter),
    queryResult: (data: any) => {
      const n = Number(data.get(0).n);
      countEl.textContent = `${n} / ${totalRows} 行`;
    },
  });
  log('[3] OK: 選択行数の表示クライアントを接続しました');
}

main().catch((err) => {
  console.error(err);
  log(`✗ エラー: ${err instanceof Error ? err.message : String(err)}`);
});
