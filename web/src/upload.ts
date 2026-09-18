// ファイル読み込み（CLAUDE.md「次にやること」1）。
//
// CSV / Excel をドロップ領域で受け取り、先頭数行を型解釈なしでプレビュー表示し、
// 「どの行をヘッダにするか」をユーザーのクリックだけで決める。数値入力
// （「ヘッダ行（0始まり）」のようなもの）は置かない。自動推定はあくまで
// 初期選択で、外れてもプレビューから選び直せば成立する設計にする
// （Python版で採用した方針をそのまま踏襲）。
//
// CSV/Excel の両方を同じ経路で扱うため、パースは SheetJS（xlsx パッケージ）に
// 寄せている。DuckDB-WASM への登録も CSV 経由に統一し、列の型判定は
// DuckDB 側の read_csv 自動判定に任せる（このモジュールでは型を判定しない）。

import * as XLSX from 'xlsx';
import type * as duckdbWasm from '@duckdb/duckdb-wasm';
import { Coordinator, loadCSV } from '@uwdata/vgplot';

export class UploadError extends Error {}

const ACCEPTED_EXTENSIONS = ['.csv', '.xlsx', '.xls'];
const PREVIEW_ROWS = 5;

export function isAcceptedFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * ファイルを、型解釈なしの2次元配列（行 x セル）に変換する。
 * CSV はテキストとして、Excel はバイナリとして SheetJS に読ませる。
 */
export async function parseRaw(file: File): Promise<unknown[][]> {
  if (!isAcceptedFile(file.name)) {
    throw new UploadError(
      `対応していないファイル形式です: ${file.name}（対応形式: ${ACCEPTED_EXTENSIONS.join(', ')}）`
    );
  }

  const isExcel = /\.xlsx?$/i.test(file.name);
  let workbook: XLSX.WorkBook;
  try {
    if (isExcel) {
      const buf = await file.arrayBuffer();
      workbook = XLSX.read(buf, { type: 'array' });
    } else {
      const text = await file.text();
      workbook = XLSX.read(text, { type: 'string', raw: true });
    }
  } catch (e) {
    throw new UploadError(
      `「${file.name}」を読み取れませんでした: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new UploadError(`「${file.name}」にシートが見つかりませんでした。`);
  }
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
    blankrows: true,
  });

  if (rows.length === 0) {
    throw new UploadError(`「${file.name}」からデータを読み取れませんでした。`);
  }
  return rows;
}

export function previewRows(rows: unknown[][]): unknown[][] {
  return rows.slice(0, PREVIEW_ROWS);
}

function cellIsNumeric(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed !== '' && Number.isFinite(Number(trimmed));
  }
  return false;
}

function rowNumericRatio(row: unknown[]): number {
  const values = row.filter((v) => v !== null && v !== undefined && v !== '');
  if (values.length === 0) return 0;
  return values.filter(cellIsNumeric).length / values.length;
}

/**
 * ヘッダ行らしい行を推定する。「その行は文字列主体」かつ「次の行は数値主体」を
 * 満たす最初の行を採用する（タイトル行・単位行を挟むデータでも、実際のヘッダの
 * 直後は必ずデータ行になることを利用）。見つからなければ 0 行目。
 * これはあくまで初期値のヒントで、最終判断は画面側でのクリックに委ねる。
 */
export function guessHeaderRow(rows: unknown[][]): number {
  for (let i = 0; i < rows.length - 1; i++) {
    const thisRowIsText = rowNumericRatio(rows[i]) < 0.5;
    const nextRowIsData = rowNumericRatio(rows[i + 1]) >= 0.5;
    if (thisRowIsText && nextRowIsData) return i;
  }
  return 0;
}

/**
 * 選ばれたヘッダ行を基準に、以降の行だけを CSV テキストに組み直す。
 * DuckDB-WASM への登録を既存の loadCSV 経路に統一するための変換で、
 * セルのクォート・エスケープは SheetJS に任せる（自前でやると壊れやすいため）。
 */
export function rowsToCsv(rows: unknown[][], headerRow: number): string {
  const sliced = rows.slice(headerRow);
  const sheet = XLSX.utils.aoa_to_sheet(sliced);
  return XLSX.utils.sheet_to_csv(sheet);
}

export interface LoadedTable {
  tableName: string;
  rowCount: number;
  columns: { name: string; type: string }[];
}

/**
 * CSV テキストを DuckDB-WASM に registerFileText し、テーブルとして登録する。
 * 列の型は DuckDB の read_csv 自動判定に任せ、登録後に DESCRIBE で読み出して返す
 * （「型を判定して登録した」ことを呼び出し側が確認できるようにするため）。
 */
export async function registerCsvTable(
  duckdb: duckdbWasm.AsyncDuckDB,
  db: Coordinator,
  tableName: string,
  csvText: string
): Promise<LoadedTable> {
  const fileName = `${tableName}-${Date.now()}.csv`;
  try {
    await duckdb.registerFileText(fileName, csvText);
    await db.exec(loadCSV(tableName, fileName, { replace: true }));
  } catch (e) {
    throw new UploadError(
      `DuckDB への登録に失敗しました: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  let rowCount: number;
  let columns: { name: string; type: string }[];
  try {
    // table を replace で作り直しても、count(*)/DESCRIBE の SQL 文字列自体は
    // 毎回同じになる。Coordinator.query() は既定でSQL文字列をキーに結果を
    // キャッシュするため、cache: false を指定しないと再アップロード時に
    // 古い（削除済みテーブルの）結果が返ってしまう。
    const countResult: any = await db.query(`SELECT count(*) AS n FROM ${tableName}`, {
      cache: false,
    });
    rowCount = Number(countResult.get(0).n);
    const describeResult: any = await db.query(`DESCRIBE ${tableName}`, { cache: false });
    columns = describeResult.toArray().map((row: any) => ({
      name: String(row.column_name),
      type: String(row.column_type),
    }));
  } catch (e) {
    throw new UploadError(
      `登録後の確認に失敗しました: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  if (rowCount === 0) {
    throw new UploadError('データ行がありません。ヘッダ行の選択を確認してください。');
  }
  if (columns.length === 0) {
    throw new UploadError('列を読み取れませんでした。ヘッダ行の選択を確認してください。');
  }

  return { tableName, rowCount, columns };
}
