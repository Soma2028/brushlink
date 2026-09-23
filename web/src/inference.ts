// 検定（CLAUDE.md「次にやること」4 の群間比較・単回帰の p 値）。
//
// 平均・分散・件数などの集計はすべて DuckDB 側で済ませ、ここには集計値だけが
// 渡ってくる。行データを JS に取り出さないので、100万行でも計算量は変わらない。
// JS 側で必要なのは t 分布・χ² 分布の累積分布関数だけで、そのために jStat を使う
// （simple-statistics は t 検定の統計量は出せるが分布関数を持たず、p 値を
// 出せないため。選定の経緯は CLAUDE.md「次にやること」4 を参照）。

import jStat from 'jstat';

export interface GroupSummary {
  n: number; // 非欠測の件数
  mean: number;
  variance: number; // 不偏分散
}

export interface WelchResult {
  t: number;
  df: number;
  p: number;
  // Cohen の d（2群をプールした SD で割った平均差）。p 値は件数が多いと
  // 小さな差でも 0 に張り付くため、「差の大きさ」は別に効果量で示す
  d: number;
}

/**
 * Welch の t 検定（等分散を仮定しない2群の平均差の検定）。
 * 選択中と選択外は件数も分散も大きく違うのが普通なので、Student の t 検定
 * （等分散を仮定）ではなく Welch を使う。
 */
export function welchTTest(a: GroupSummary, b: GroupSummary): WelchResult | null {
  if (a.n < 2 || b.n < 2) return null;
  const va = a.variance / a.n;
  const vb = b.variance / b.n;
  const se = Math.sqrt(va + vb);
  const pooledSd = Math.sqrt(((a.n - 1) * a.variance + (b.n - 1) * b.variance) / (a.n + b.n - 2));
  if (!(se > 0) || !(pooledSd > 0)) return null;
  const t = (a.mean - b.mean) / se;
  const df = (va + vb) ** 2 / (va ** 2 / (a.n - 1) + vb ** 2 / (b.n - 1));
  const p = 2 * (1 - jStat.studentt.cdf(Math.abs(t), df));
  return { t, df, p: clampP(p), d: (a.mean - b.mean) / pooledSd };
}

/**
 * 母集団の集計値から選択中の集計値を差し引いて、選択外（母集団の残り）の
 * 件数・平均・分散を求める。
 *
 * 選択外を別クエリで集計すると「母集団 AND NOT 選択」という述語を組む必要が
 * あり、NOT が欠測（NULL）を落とす問題を再び抱えることになる。選択中は
 * 母集団の部分集合なので、分散の合成公式（Chan らの並列アルゴリズム）を
 * 逆向きに使えば、既にある2つの集計から正確に求まる。
 */
export function subtractGroup(pop: GroupSummary, sel: GroupSummary): GroupSummary | null {
  const n = pop.n - sel.n;
  if (n < 1) return null;
  const mean = (pop.n * pop.mean - sel.n * sel.mean) / n;
  const m2Pop = pop.variance * (pop.n - 1);
  const m2Sel = sel.n > 1 ? sel.variance * (sel.n - 1) : 0;
  const delta = mean - sel.mean;
  const m2 = m2Pop - m2Sel - (delta * delta * sel.n * n) / pop.n;
  // 選択中と母集団の集計は別々のクエリで返ってくるため、更新の途中では
  // 一瞬だけ食い違い、負の分散になりうる。その場合は0に丸める
  return { n, mean, variance: n > 1 ? Math.max(m2, 0) / (n - 1) : 0 };
}

export interface ChiSquareResult {
  chi2: number;
  df: number;
  p: number;
  cramersV: number; // 関連の強さ（0〜1）。p 値と同じ理由で効果量を添える
}

/**
 * 分割表（行 = 群、列 = カテゴリ）の独立性の χ² 検定。
 * 「選択中と選択外でカテゴリの構成比が違うか」を見るのに使う。
 */
export function chiSquareTest(table: number[][]): ChiSquareResult | null {
  const rows = table.length;
  const cols = table[0]?.length ?? 0;
  const rowSums = table.map((r) => r.reduce((s, v) => s + v, 0));
  const colSums = Array.from({ length: cols }, (_, j) => table.reduce((s, r) => s + r[j], 0));
  const total = rowSums.reduce((s, v) => s + v, 0);
  // 全件が0の行・列は検定に寄与しないので除いて自由度を数える
  const liveRows = rowSums.filter((v) => v > 0).length;
  const liveCols = colSums.filter((v) => v > 0).length;
  if (total === 0 || liveRows < 2 || liveCols < 2) return null;

  let chi2 = 0;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const expected = (rowSums[i] * colSums[j]) / total;
      if (expected > 0) chi2 += (table[i][j] - expected) ** 2 / expected;
    }
  }
  const df = (liveRows - 1) * (liveCols - 1);
  const p = 1 - jStat.chisquare.cdf(chi2, df);
  const cramersV = Math.sqrt(chi2 / (total * Math.min(liveRows - 1, liveCols - 1)));
  return { chi2, df, p: clampP(p), cramersV };
}

/** 単回帰の傾きが 0 かどうかの t 検定の p 値（相関係数 r と件数 n から）。 */
export function correlationPValue(r: number, n: number): number | null {
  if (n < 3 || !Number.isFinite(r)) return null;
  if (Math.abs(r) >= 1) return 0;
  const t = r * Math.sqrt((n - 2) / (1 - r * r));
  return clampP(2 * (1 - jStat.studentt.cdf(Math.abs(t), n - 2)));
}

function clampP(p: number): number {
  return Math.min(1, Math.max(0, p));
}

/**
 * p 値の表示。浮動小数点では 1 − cdf が 0 に潰れるため、小さい値は
 * 「< 0.001」と下限で示す（「p = 0」と出すと誤解を招くため）。
 */
export function formatP(p: number | null): string {
  if (p === null) return '—';
  if (p < 0.001) return '< 0.001';
  return p.toFixed(3);
}

/**
 * 効果量 d の大きさを言葉にする。Cohen の目安（0.2 小・0.5 中・0.8 大）に従う。
 * 初心者向けの文章要約と、表のバーの濃さの両方で同じ区切りを使う。
 */
export function effectLabel(d: number): 'なし' | '小' | '中' | '大' {
  const a = Math.abs(d);
  if (a >= 0.8) return '大';
  if (a >= 0.5) return '中';
  if (a >= 0.2) return '小';
  return 'なし';
}
