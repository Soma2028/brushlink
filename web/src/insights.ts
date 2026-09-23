// 選択範囲の特徴を文章で要約する。
//
// 統計表は情報が多く、初心者は「で、何が分かったのか」を読み取りにくい。
// 群間比較（stats.ts / categories.ts）の結果から、差の大きい列を上位だけ
// 拾って日本語の文にする。データサイエンティストは表を見ればよいので、
// 要約はあくまで入口として短く保つ。
//
// 選択に使った列（散布図やヒストグラムで範囲を切った列）は要約から除く。
// その列で選んだのだから差が出るのは当然で、要約の上位を占めると
// 本当に知りたい「他に何が違うか」が埋もれてしまうため。

import type { NumericComparison } from './stats';
import type { CategoryComparison } from './categories';
import { formatStat } from './stats';
import { effectLabel } from './inference';
import { escapeHtml } from './dom';

// 要約に載せる基準。有意（p < 0.05）かつ効果量が「小」以上の列だけを拾う。
// p 値だけだと、件数が多いときに実質的に意味のない差まで並んでしまうため
const P_THRESHOLD = 0.05;
const MIN_EFFECT = 0.2;
const MIN_CRAMERS_V = 0.1;
const MAX_ITEMS = 4;

export interface InsightInput {
  hasSelection: boolean;
  selectedCount: number;
  populationCount: number;
  numeric: NumericComparison[];
  categorical: CategoryComparison[];
  brushedCols: Set<string>;
  axisNote: string | null; // 選択が無いときに出す、自動選択した軸の説明
}

export function renderInsights(container: HTMLElement, input: InsightInput) {
  if (!input.hasSelection) {
    container.innerHTML = `
      <div class="insight-idle">
        <div class="insight-icon" aria-hidden="true">👆</div>
        <div>
          <strong>チャートの上をドラッグして、気になる範囲を選んでみましょう。</strong>
          <p>選んだ行が他の行と何が違うのかを、ここに文章でまとめます。</p>
          ${input.axisNote ? `<p class="muted">${input.axisNote}</p>` : ''}
        </div>
      </div>`;
    return;
  }

  type Item = { score: number; html: string };
  const items: Item[] = [];

  for (const cmp of input.numeric) {
    const t = cmp.test;
    if (!t || input.brushedCols.has(cmp.column)) continue;
    if (t.p >= P_THRESHOLD || Math.abs(t.d) < MIN_EFFECT) continue;
    const dir = t.d > 0 ? '高い' : '低い';
    items.push({
      score: Math.abs(t.d),
      html: `<li><span class="dir ${t.d > 0 ? 'up' : 'down'}">${t.d > 0 ? '▲' : '▼'}</span>
        <strong>${escapeHtml(cmp.column)}</strong> が${dir}
        <span class="muted">（平均 ${formatStat(cmp.selMean)}、選択外は ${formatStat(cmp.restMean)}・差は${effectLabel(t.d)}）</span></li>`,
    });
  }

  for (const cmp of input.categorical) {
    const t = cmp.test;
    const shift = cmp.topShift;
    if (!t || !shift || input.brushedCols.has(cmp.column)) continue;
    if (t.p >= P_THRESHOLD || t.cramersV < MIN_CRAMERS_V || shift.selShare <= shift.restShare) continue;
    items.push({
      // 効果量 d と Cramér の V は尺度が違うので、V を d のおおよその目安
      // （V 0.1/0.3/0.5 ≒ d 0.2/0.5/0.8）に換算して並べ替えに使う
      score: t.cramersV * 1.6,
      html: `<li><span class="dir cat">■</span>
        <strong>${escapeHtml(cmp.column)}</strong> は「${escapeHtml(shift.category)}」が多い
        <span class="muted">（${(shift.selShare * 100).toFixed(0)}%、選択外は ${(shift.restShare * 100).toFixed(0)}%）</span></li>`,
    });
  }

  items.sort((a, b) => b.score - a.score);
  const share = input.populationCount > 0 ? (input.selectedCount / input.populationCount) * 100 : 0;
  const lead = `選んだ <strong>${input.selectedCount.toLocaleString()} 件</strong>（母集団の ${share.toFixed(share >= 10 ? 0 : 1)}%）は、残りの ${(input.populationCount - input.selectedCount).toLocaleString()} 件と比べて…`;
  const brushed =
    input.brushedCols.size > 0
      ? `<p class="insight-foot">選択に使った列（${[...input.brushedCols].map(escapeHtml).join('、')}）は、差が出て当然なので除いています。</p>`
      : '';

  container.innerHTML = items.length
    ? `<p class="insight-lead">${lead}</p><ul class="insight-list">${items.slice(0, MAX_ITEMS).map((i) => i.html).join('')}</ul>${brushed}`
    : `<p class="insight-lead">${lead}</p><p class="insight-none">はっきりした違いのある列は見つかりませんでした（有意かつ効果量が小以上のもの）。</p>${brushed}`;
}
