// 機械学習の計算を担う Web Worker。ml.ts の関数を呼ぶだけの薄い窓口。
// ランダムフォレストなどを別スレッドで回し、計算中もドラッグや
// スクロールが引っかからないようにする。

import { standardize, kmeans, chooseK, pca, randomForestImportance } from './ml';
import type { MLRequest, MLResponse } from './ml-protocol';

// tsconfig の lib が DOM 前提のため、Worker 側の postMessage の型を最小限で宣言する
const ctx = self as unknown as { postMessage(message: MLResponse): void };

self.addEventListener('message', (event: MessageEvent<MLRequest>) => {
  const req = event.data;
  try {
    if (req.type === 'kmeans') {
      const { z, means, sds } = standardize(req.X);
      const choice = req.k === null ? chooseK(z) : null;
      const k = req.k ?? choice!.k;
      const result = kmeans(z, k);
      ctx.postMessage({
        id: req.id,
        type: 'kmeans',
        k,
        scores: choice?.scores ?? null,
        labels: result.labels,
        centroids: result.centroids,
        means,
        sds,
      });
    } else if (req.type === 'pca') {
      const { z, means, sds } = standardize(req.X);
      const result = pca(z);
      ctx.postMessage({ id: req.id, type: 'pca', ...result, means, sds });
    } else {
      const result = randomForestImportance(req.X, req.y);
      ctx.postMessage({ id: req.id, type: 'importance', ...result });
    }
  } catch (e) {
    ctx.postMessage({ id: req.id, type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
});
