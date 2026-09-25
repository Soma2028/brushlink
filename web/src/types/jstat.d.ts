// jStat には型定義が同梱されておらず、@types/jstat も存在しないため、
// このプロジェクトで使う関数（分布の累積分布関数）だけを宣言する。
declare module 'jstat' {
  interface Distribution {
    cdf(x: number, dof: number): number;
  }
  interface FDistribution {
    cdf(x: number, df1: number, df2: number): number;
  }
  interface NormalDistribution {
    inv(p: number, mean: number, sd: number): number;
  }
  interface JStatStatic {
    studentt: Distribution;
    chisquare: Distribution;
    centralF: FDistribution;
    normal: NormalDistribution;
  }
  const jStat: JStatStatic;
  export default jStat;
}
