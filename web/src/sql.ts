// SQL 組み立ての小さな共通処理。

import { and } from '@uwdata/mosaic-sql';

/** 識別子（列名・テーブル名）を二重引用符で囲む。列名に記号や空白があっても壊れないように。 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Mosaic の Selection が返す述語（式の配列、または undefined）を SQL の
 * WHERE 句に埋め込める文字列にする。条件が無いときは TRUE。
 *
 * 機械学習用の行取得や列の書き込み（UPDATE）は Mosaic クライアントを
 * 経由しない1回きりのクエリなので、Selection の条件を文字列として取り出して
 * 自前の SQL に埋め込む必要がある。
 */
export function predicateSql(pred: unknown): string {
  if (pred === undefined || pred === null) return 'TRUE';
  // 解除されたブラシは述語が null の節として残るので取り除く
  const list = (Array.isArray(pred) ? pred : [pred]).filter((p) => p !== null && p !== undefined);
  if (list.length === 0) return 'TRUE';
  const s = String(and(list as any));
  return s.trim() === '' ? 'TRUE' : s;
}
