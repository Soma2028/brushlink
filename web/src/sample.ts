// サンプルデータ生成。
//
// 手元にファイルが無い初めての人でも、ページを開いてボタン1つで
// クロスフィルタを触れるようにするため（製品方針「初心者が説明なしに触れる」）。
// 外部ファイルを配らずブラウザ内で生成するのは、静的配信のサイズを増やさず、
// 生成規則をコードとして読める形で残すため。
//
// 中身は架空の製造ラインの品質測定データ。クロスフィルタの見せ場が
// 出るように、列間に相関（温度→厚み→強度）とライン差を仕込み、
// 実データを想定して一部の列に欠測を混ぜてある。
// 生成結果はアップロードと同じ2次元配列で返し、読み込み経路を共通化する。

// 再読み込みしても同じデータになるよう、シード付きの疑似乱数を使う
// （Math.random だと見るたびに図が変わり、説明や検証がしづらい）。
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round(value: number, digits: number): number {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

export const SAMPLE_FILE_NAME = 'サンプル: 製造ライン品質データ.csv';

export function generateSampleRows(rowCount = 3000): unknown[][] {
  const rand = mulberry32(20260923);
  // Box-Muller 法で標準正規乱数を作る
  const normal = (): number => {
    const u = 1 - rand();
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const pick = <T>(items: T[]): T => items[Math.floor(rand() * items.length)];
  // 測定漏れを再現するため、指定確率で null にする
  const maybeMissing = (value: number, rate: number): number | null =>
    rand() < rate ? null : value;

  const lines = ['A', 'B', 'C'];
  const shifts = ['日勤', '夜勤'];
  const materials = ['標準材', '高強度材', '再生材'];
  // ラインごとの温度のクセ。ライン C だけ高めに振れるようにして、
  // 「強度が低い点を選ぶとライン C に偏っている」が見つかる構造にする
  const lineTempOffset: Record<string, number> = { A: 0, B: -3, C: 8 };

  const rows: unknown[][] = [
    ['ライン', 'シフト', '材料', '温度', '湿度', '圧力', '厚み', '強度', '不良率'],
  ];
  for (let i = 0; i < rowCount; i++) {
    const line = pick(lines);
    const shift = pick(shifts);
    const material = pick(materials);
    const temp = 180 + lineTempOffset[line] + (shift === '夜勤' ? -2 : 0) + normal() * 6;
    const humidity = 45 + normal() * 8;
    const pressure = 2.4 + normal() * 0.15;
    const thickness = 1.2 + (temp - 180) * 0.012 + (pressure - 2.4) * 0.3 + normal() * 0.05;
    const materialBonus = material === '高強度材' ? 40 : material === '再生材' ? -25 : 0;
    const strength =
      520 + materialBonus - (thickness - 1.2) * 600 - (humidity - 45) * 1.2 + normal() * 18;
    const defect = Math.max(0, 1.5 + (humidity - 45) * 0.08 + (520 - strength) * 0.02 + normal() * 0.6);

    rows.push([
      line,
      shift,
      material,
      maybeMissing(round(temp, 1), 0.03),
      maybeMissing(round(humidity, 1), 0.06),
      round(pressure, 3),
      maybeMissing(round(thickness, 3), 0.02),
      round(strength, 1),
      round(defect, 2),
    ]);
  }
  return rows;
}
