// jStat には型定義が同梱されておらず、@types/jstat も存在しないため、
// このプロジェクトで使う関数（分布の累積分布関数）だけを宣言する。
declare module 'jstat' {
  interface Distribution {
    cdf(x: number, dof: number): number;
  }
  interface JStatStatic {
    studentt: Distribution;
    chisquare: Distribution;
  }
  const jStat: JStatStatic;
  export default jStat;
}
