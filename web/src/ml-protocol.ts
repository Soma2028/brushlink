// メインスレッドと ml.worker.ts の間でやり取りするメッセージの型。

import type { Matrix } from './ml';

export type MLRequest =
  | { id: number; type: 'kmeans'; X: Matrix; k: number | null }
  | { id: number; type: 'pca'; X: Matrix }
  | { id: number; type: 'importance'; X: Matrix; y: number[] };

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
  | { id: number; type: 'error'; message: string };
