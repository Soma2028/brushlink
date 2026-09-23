// ドラッグが止まってから追従する Selection（遅延ミラー）。
//
// チャート（ヒストグラム・散布図）はドラッグ中も毎フレーム連動させたいが、
// 統計量・カテゴリ構成・回帰・データ表まで毎フレーム集計し直すと、
// DuckDB-WASM は1本のキューでクエリを順に処理するため待ち行列が詰まり、
// 5万行近いデータではドラッグを離してから数秒遅れて反映されるようになった。
// そこで集計系のクライアントには、元の Selection を少し遅れて写し取る
// ミラーを渡し、ドラッグが一瞬止まったときにだけ集計させる。

import { Selection } from '@uwdata/mosaic-core';

// ドラッグの手が止まったとみなす間隔。短すぎるとドラッグ中にも集計が走り、
// 長すぎると離してからの反映が遅く感じる
const SETTLE_MS = 180;

export function settledMirror(source: Selection, delay = SETTLE_MS): Selection {
  const mirror = Selection.intersect();
  let timer: number | undefined;

  const sync = () => {
    const live = new Set(source.clauses.map((c) => c.source));
    // 元から消えた節（解除されたブラシなど）は、述語 null の更新で取り除く
    for (const c of mirror.clauses) {
      if (!live.has(c.source)) mirror.update({ source: c.source, value: null, predicate: null } as any);
    }
    for (const c of source.clauses) mirror.update(c);
  };

  source.addEventListener('value', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(sync, delay);
  });
  sync();
  return mirror;
}
