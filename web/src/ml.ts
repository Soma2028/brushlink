// 簡易機械学習のアルゴリズム本体（CLAUDE.md「次にやること」6）。
//
// k-means・PCA・ランダムフォレストによる変数重要度を、外部ライブラリなしで
// 実装している。対象は「選択範囲から取り出した数千行 × 十数列」の小さな
// 行列なので、どれも素朴な実装で十分な速さが出る。ライブラリを足さなかった
// のは、(1) mljs 系はそれぞれ別パッケージで、3手法ぶん依存が増える、
// (2) ランダムフォレストの変数重要度を出せる軽量な JS 実装が見当たらない、
// (3) 乱数のシードを固定して「同じ選択なら同じ結果」を保証したい、のため。
//
// このモジュールは DOM に触れない純粋な計算だけを置き、Web Worker
// （ml.worker.ts）から呼ぶ。ランダムフォレストは数百ミリ秒かかることがあり、
// メインスレッドで回すとドラッグ中の操作が引っかかるため。

export type Matrix = number[][];

/** シード付き疑似乱数（sample.ts と同じ mulberry32）。結果を再現可能にするため。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Standardized {
  z: Matrix;
  means: number[];
  sds: number[];
}

/**
 * 列ごとに平均0・標準偏差1に揃える。k-means と PCA は距離・分散に基づくので、
 * 単位の大きい列（例: 強度 500 前後）が単位の小さい列（厚み 1 前後）を
 * 圧倒しないようにするため。呼び出し側で定数列は除いておく前提。
 */
export function standardize(X: Matrix): Standardized {
  const n = X.length;
  const p = X[0]?.length ?? 0;
  const means = new Array(p).fill(0);
  const sds = new Array(p).fill(0);
  for (const row of X) for (let j = 0; j < p; j++) means[j] += row[j] / n;
  for (const row of X) for (let j = 0; j < p; j++) sds[j] += (row[j] - means[j]) ** 2;
  for (let j = 0; j < p; j++) sds[j] = Math.sqrt(sds[j] / Math.max(n - 1, 1)) || 1;
  const z = X.map((row) => row.map((v, j) => (v - means[j]) / sds[j]));
  return { z, means, sds };
}

function sqDist(a: number[], b: number[]): number {
  let s = 0;
  for (let j = 0; j < a.length; j++) s += (a[j] - b[j]) ** 2;
  return s;
}

export interface KMeansResult {
  labels: number[];
  centroids: Matrix;
  inertia: number;
}

/**
 * k-means（初期値は k-means++、Lloyd 法で反復）。局所解に落ちやすいので
 * 初期値を変えて nInit 回走らせ、クラスタ内平方和が最小のものを採る
 * （scikit-learn の既定と同じ考え方）。
 */
export function kmeans(z: Matrix, k: number, seed = 1, nInit = 4, maxIter = 100): KMeansResult {
  const rand = mulberry32(seed);
  let best: KMeansResult | null = null;
  for (let run = 0; run < nInit; run++) {
    // k-means++: 既存の中心から遠い点ほど選ばれやすくして初期中心を散らす
    const centroids: Matrix = [z[Math.floor(rand() * z.length)].slice()];
    const d2 = z.map((row) => sqDist(row, centroids[0]));
    while (centroids.length < k) {
      const total = d2.reduce((s, v) => s + v, 0);
      let r = rand() * total;
      let idx = 0;
      while (idx < z.length - 1 && r > d2[idx]) r -= d2[idx++];
      centroids.push(z[idx].slice());
      for (let i = 0; i < z.length; i++) d2[i] = Math.min(d2[i], sqDist(z[i], centroids[centroids.length - 1]));
    }

    const labels = new Array(z.length).fill(-1);
    for (let iter = 0; iter < maxIter; iter++) {
      let changed = false;
      for (let i = 0; i < z.length; i++) {
        let bestC = 0;
        let bestD = Infinity;
        for (let c = 0; c < k; c++) {
          const d = sqDist(z[i], centroids[c]);
          if (d < bestD) [bestD, bestC] = [d, c];
        }
        if (labels[i] !== bestC) {
          labels[i] = bestC;
          changed = true;
        }
      }
      if (!changed) break;
      const sums = centroids.map((c) => new Array(c.length).fill(0));
      const counts = new Array(k).fill(0);
      z.forEach((row, i) => {
        counts[labels[i]]++;
        row.forEach((v, j) => (sums[labels[i]][j] += v));
      });
      for (let c = 0; c < k; c++) {
        // 空になったクラスタは中心を動かさない（点が戻ってくる余地を残す）
        if (counts[c] > 0) centroids[c] = sums[c].map((s) => s / counts[c]);
      }
    }
    const inertia = z.reduce((s, row, i) => s + sqDist(row, centroids[labels[i]]), 0);
    if (!best || inertia < best.inertia) best = { labels, centroids, inertia };
  }
  return best!;
}

/**
 * シルエット係数の平均（-1〜1、大きいほどクラスタがよく分かれている）。
 * 全点対の距離が要るので O(n²)。最大 maxN 点に間引いて計算する。
 */
export function silhouette(z: Matrix, labels: number[], k: number, seed = 7, maxN = 600): number {
  const rand = mulberry32(seed);
  let idx = z.map((_, i) => i);
  if (idx.length > maxN) {
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    idx = idx.slice(0, maxN);
  }
  let total = 0;
  let counted = 0;
  for (const i of idx) {
    const sum = new Array(k).fill(0);
    const cnt = new Array(k).fill(0);
    for (const j of idx) {
      if (i === j) continue;
      sum[labels[j]] += Math.sqrt(sqDist(z[i], z[j]));
      cnt[labels[j]]++;
    }
    const own = labels[i];
    if (cnt[own] === 0) continue; // 1点だけのクラスタはシルエットを定義しない
    const a = sum[own] / cnt[own];
    let b = Infinity;
    for (let c = 0; c < k; c++) if (c !== own && cnt[c] > 0) b = Math.min(b, sum[c] / cnt[c]);
    if (!Number.isFinite(b)) continue;
    total += (b - a) / Math.max(a, b);
    counted++;
  }
  return counted > 0 ? total / counted : 0;
}

export interface KChoice {
  k: number;
  scores: { k: number; silhouette: number }[];
}

/**
 * クラスタ数 k を 2〜kMax の中からシルエット係数が最大になるものに自動で決める。
 * 初心者に k を考えさせないため（製品方針「初期状態は自動で組み立てる」）。
 * 変えたい人は画面から k を指定し直せる。
 */
export function chooseK(z: Matrix, kMax = 6): KChoice {
  const scores: { k: number; silhouette: number }[] = [];
  for (let k = 2; k <= Math.min(kMax, z.length - 1); k++) {
    const res = kmeans(z, k, 1, 2);
    scores.push({ k, silhouette: silhouette(z, res.labels, k) });
  }
  const best = scores.reduce((a, b) => (b.silhouette > a.silhouette ? b : a), scores[0]);
  return { k: best?.k ?? 2, scores };
}

/**
 * 対称行列の固有値分解（Jacobi 法）。PCA で相関行列を分解するのに使う。
 * 列数は多くても数十なので、収束の遅い素朴な方法で十分。
 * 戻り値の vectors[i] が i 番目の固有値に対応する固有ベクトル。
 */
export function jacobiEigen(A: Matrix, maxSweeps = 100): { values: number[]; vectors: Matrix } {
  const n = A.length;
  const a = A.map((r) => r.slice());
  const v: Matrix = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] ** 2;
    if (off < 1e-20) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-15) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const values = a.map((r, i) => r[i]);
  const vectors = values.map((_, i) => v.map((row) => row[i]));
  return { values, vectors };
}

export interface PCAResult {
  explained: number[]; // 各主成分の寄与率（合計1）
  loadings: Matrix; // loadings[c][j] = 主成分 c における列 j の係数（単位ベクトル）
}

/**
 * 主成分分析。標準化済みの行列から相関行列を作り、固有値の大きい順に並べる。
 * 固有ベクトルの符号は任意なので、絶対値最大の係数が正になるように揃える
 * （選択を変えるたびに軸の向きが反転して見えるのを防ぐため）。
 */
export function pca(z: Matrix): PCAResult {
  const n = z.length;
  const p = z[0].length;
  const cov: Matrix = Array.from({ length: p }, () => new Array(p).fill(0));
  for (const row of z) {
    for (let i = 0; i < p; i++) for (let j = i; j < p; j++) cov[i][j] += (row[i] * row[j]) / (n - 1);
  }
  for (let i = 0; i < p; i++) for (let j = 0; j < i; j++) cov[i][j] = cov[j][i];
  const { values, vectors } = jacobiEigen(cov);
  const order = values.map((_, i) => i).sort((a, b) => values[b] - values[a]);
  const total = values.reduce((s, v) => s + Math.max(v, 0), 0) || 1;
  return {
    explained: order.map((i) => Math.max(values[i], 0) / total),
    loadings: order.map((i) => {
      const vec = vectors[i];
      const maxIdx = vec.reduce((m, v, j) => (Math.abs(v) > Math.abs(vec[m]) ? j : m), 0);
      return vec[maxIdx] < 0 ? vec.map((v) => -v) : vec;
    }),
  };
}

// ---------------------------------------------------------------------------
// ランダムフォレスト（2値分類）による変数重要度
// ---------------------------------------------------------------------------

interface TreeNode {
  feature: number; // 葉なら -1
  threshold: number;
  left: TreeNode | null;
  right: TreeNode | null;
  prob: number; // 葉での「選択中」の割合
}

interface ForestOptions {
  nTrees: number;
  maxDepth: number;
  minLeaf: number;
  seed: number;
}

function gini(pos: number, n: number): number {
  if (n === 0) return 0;
  const q = pos / n;
  return 2 * q * (1 - q);
}

function buildTree(
  X: Matrix,
  y: number[],
  indices: number[],
  depth: number,
  opts: ForestOptions,
  mtry: number,
  rand: () => number,
  importance: number[]
): TreeNode {
  const n = indices.length;
  let pos = 0;
  for (const i of indices) pos += y[i];
  const leaf: TreeNode = { feature: -1, threshold: 0, left: null, right: null, prob: n > 0 ? pos / n : 0 };
  if (depth >= opts.maxDepth || n < opts.minLeaf * 2 || pos === 0 || pos === n) return leaf;

  const p = X[0].length;
  const parentImpurity = gini(pos, n) * n;
  let bestGain = 0;
  let bestFeature = -1;
  let bestThreshold = 0;

  // 各分岐で列を mtry 個だけ無作為に選ぶ（木どうしの相関を下げる、RF の要点）
  const features = Array.from({ length: p }, (_, j) => j);
  for (let i = 0; i < mtry; i++) {
    const j = i + Math.floor(rand() * (p - i));
    [features[i], features[j]] = [features[j], features[i]];
  }
  for (const f of features.slice(0, mtry)) {
    const sorted = indices.slice().sort((a, b) => X[a][f] - X[b][f]);
    let leftPos = 0;
    for (let k = 0; k < n - 1; k++) {
      leftPos += y[sorted[k]];
      const nl = k + 1;
      if (nl < opts.minLeaf || n - nl < opts.minLeaf) continue;
      const v = X[sorted[k]][f];
      const next = X[sorted[k + 1]][f];
      if (v === next) continue; // 同じ値の間では切れない
      const gain = parentImpurity - gini(leftPos, nl) * nl - gini(pos - leftPos, n - nl) * (n - nl);
      if (gain > bestGain) {
        bestGain = gain;
        bestFeature = f;
        bestThreshold = (v + next) / 2;
      }
    }
  }
  if (bestFeature < 0) return leaf;

  // 不純度の減少量（件数で重み付け）をその列の重要度に積み上げる
  // （scikit-learn の feature_importances_ と同じ Gini 重要度）
  importance[bestFeature] += bestGain;
  const leftIdx = indices.filter((i) => X[i][bestFeature] <= bestThreshold);
  const rightIdx = indices.filter((i) => X[i][bestFeature] > bestThreshold);
  return {
    feature: bestFeature,
    threshold: bestThreshold,
    left: buildTree(X, y, leftIdx, depth + 1, opts, mtry, rand, importance),
    right: buildTree(X, y, rightIdx, depth + 1, opts, mtry, rand, importance),
    prob: leaf.prob,
  };
}

function predict(node: TreeNode, row: number[]): number {
  let cur = node;
  while (cur.feature >= 0) cur = row[cur.feature] <= cur.threshold ? cur.left! : cur.right!;
  return cur.prob;
}

export interface ImportanceResult {
  importance: number[]; // 合計1に正規化
  // 学習に使わなかった行（OOB）での正解率。選択中と選択外の件数差に
  // 引きずられないよう、両クラスの正解率の平均（balanced accuracy）にする
  oobBalancedAccuracy: number | null;
}

/**
 * 「選択中(1) / 選択外(0)」を見分けるランダムフォレストを学習し、
 * 列ごとの重要度を返す。
 *
 * 選択中は母集団の数%ということも多いので、各木のブートストラップ標本は
 * 両クラスから同数ずつ抜く（balanced random forest）。そうしないと
 * 「全部選択外と答える」木ばかりになり、重要度が意味をなさなくなる。
 */
export function randomForestImportance(
  X: Matrix,
  y: number[],
  opts: ForestOptions = { nTrees: 60, maxDepth: 8, minLeaf: 5, seed: 42 }
): ImportanceResult {
  const rand = mulberry32(opts.seed);
  const p = X[0].length;
  const mtry = Math.max(1, Math.round(Math.sqrt(p)));
  const importance = new Array(p).fill(0);
  const posIdx = y.map((v, i) => (v === 1 ? i : -1)).filter((i) => i >= 0);
  const negIdx = y.map((v, i) => (v === 0 ? i : -1)).filter((i) => i >= 0);
  const perClass = Math.min(posIdx.length, negIdx.length);

  const oobSum = new Array(X.length).fill(0);
  const oobCount = new Array(X.length).fill(0);

  for (let t = 0; t < opts.nTrees; t++) {
    const inBag = new Uint8Array(X.length);
    const sample: number[] = [];
    for (const group of [posIdx, negIdx]) {
      for (let k = 0; k < perClass; k++) {
        const i = group[Math.floor(rand() * group.length)];
        sample.push(i);
        inBag[i] = 1;
      }
    }
    const tree = buildTree(X, y, sample, 0, opts, mtry, rand, importance);
    for (let i = 0; i < X.length; i++) {
      if (!inBag[i]) {
        oobSum[i] += predict(tree, X[i]);
        oobCount[i]++;
      }
    }
  }

  let tp = 0, fn = 0, tn = 0, fp = 0;
  for (let i = 0; i < X.length; i++) {
    if (oobCount[i] === 0) continue;
    const pred = oobSum[i] / oobCount[i] >= 0.5 ? 1 : 0;
    if (y[i] === 1) pred === 1 ? tp++ : fn++;
    else pred === 0 ? tn++ : fp++;
  }
  const oob = tp + fn > 0 && tn + fp > 0 ? (tp / (tp + fn) + tn / (tn + fp)) / 2 : null;
  const total = importance.reduce((s, v) => s + v, 0) || 1;
  return { importance: importance.map((v) => v / total), oobBalancedAccuracy: oob };
}
