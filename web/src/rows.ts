// 選択中の行のデータ表。
//
// チャートや統計量は集計なので、「実際にどの行を選んだのか」は見えない。
// 外れ値を囲んだときに、その行の他の列の値（ロット番号や備考など）を
// そのまま確かめられるよう、選択中の行を表で出す（Python版にもあった機能）。
// 表示は先頭 ROW_LIMIT 行に限る。全件を DOM に並べると数万行で固まるため。

import { makeClient } from '@uwdata/mosaic-core';
import type { Selection } from '@uwdata/mosaic-core';
import { Query } from '@uwdata/mosaic-sql';
import type { Coordinator } from '@uwdata/vgplot';
import { escapeHtml } from './dom';
import { formatStat } from './stats';

const ROW_LIMIT = 200;

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '<span class="null-cell">欠測</span>';
  if (typeof v === 'number') return formatStat(v);
  if (typeof v === 'bigint') return v.toLocaleString();
  if (v instanceof Date) return escapeHtml(v.toISOString().slice(0, 10));
  return escapeHtml(String(v));
}

export function connectRowsClient(
  db: Coordinator,
  tableName: string,
  columns: string[],
  $selected: Selection,
  container: HTMLElement
) {
  // 機械学習で列が増えたときに繋ぎ直せるよう、作ったクライアントを返す
  return makeClient({
    coordinator: db,
    // 事前集計（preaggregation）を使わせない。Mosaic の事前集計はブラシの
    // 範囲を画面のピクセル単位に丸めて集計するため、描画には十分でも
    // 件数や平均が厳密な値から1件単位でずれる（統計量として出す値には不適）
    filterStable: false,
    selection: $selected,
    query: (filter) =>
      Query.from(tableName)
        .select(...columns)
        .where(filter)
        .limit(ROW_LIMIT),
    queryResult: (data: any) => {
      const rows: any[] = data.toArray();
      const head = columns.map((c) => `<th scope="col">${escapeHtml(c)}</th>`).join('');
      const body = rows
        .map((r) => `<tr>${columns.map((c) => `<td>${formatCell(r[c])}</td>`).join('')}</tr>`)
        .join('');
      container.innerHTML = `
        <p class="hint">選択中の行を${rows.length >= ROW_LIMIT ? `先頭 ${ROW_LIMIT} 行まで` : 'すべて'}表示しています（選択が無いときは母集団）。</p>
        <div class="rows-scroll">
          <table class="rows-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
        </div>`;
    },
  });
}
