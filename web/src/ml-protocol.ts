// メインスレッドと ml.worker.ts の間でやり取りするメッセージの型。

import type { Matrix, FlatTree, Linkage } from './ml';

export type MLRequest =
  | { id: number; type: 'kmeans'; X: Matrix; k: number | null }
  | { id: number; type: 'pca'; X: Matrix }
  | { id: number; type: 'importance'; X: Matrix; y: number[] }
  | { id: number; type: 'hclust'; X: Matrix; method: Linkage; standardize: boolean };

export type MLResponse =
  | {
      id: number;
      type: 'kmeans';
      k: number;
      scores: { k: number; silhouette: number }[] | null;
      labels: number[];
      centroids: Matrix;
      means: number[];
      sds: number[];
    }
  | { id: number; type: 'pca'; explained: number[]; loadings: Matrix; means: number[]; sds: number[] }
  | { id: number; type: 'importance'; importance: number[]; oobBalancedAccuracy: number | null }
  | {
      id: number;
      type: 'hclust';
      rows: FlatTree;
      cols: FlatTree;
      Z: Matrix; // 表示用の列ごとの z 値（標準化しない設定でも、色の濃さは列ごとに揃える）
      means: number[];
      sds: number[];
      ms: number; // 計算にかかった時間（行数の上限の根拠を画面でも確かめられるように）
    }
  | { id: number; type: 'error'; message: string };
