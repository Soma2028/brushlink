// グラフの種類の選択・追加・削除と、どの種類も選択（$brush）に参加して
// 連動することの確認。
//
// 培養データに近い形のテスト用データを作る: カテゴリ「条件」（3水準）、
// 整数の「時間」（折れ線の横軸になる）、条件で平均がずれる「濃度」、
// 欠測を含む「生存率」。期待値はここで作ったデータから直接数える。

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApp, loadCsv, card, control, plotSvg, drag, waitForSelection } from './helpers';

const CONDITIONS = ['処理A', '処理B', '対照'];

function makeCultureCsv() {
  let a = 12345;
  const rand = () => {
    a = (a * 1103515245 + 12345) % 2147483648;
    return a / 2147483648;
  };
  const rows: { cond: string; time: number; conc: number; surv: number | null }[] = [];
  for (let i = 0; i < 300; i++) {
    const cond = CONDITIONS[i % 3];
    const time = 6 + Math.floor(rand() * 60);
    const shift = cond === '処理A' ? 6 : cond === '処理B' ? -3 : 0;
    rows.push({
      cond,
      time,
      conc: 25 + shift + time * 0.1 + (rand() - 0.5) * 8,
      surv: rand() < 0.05 ? null : 80 + (rand() - 0.5) * 20,
    });
  }
  const dir = join(dirname(fileURLToPath(import.meta.url)), '.fixtures');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'culture.csv');
  writeFileSync(
    path,
    ['ID,時間,濃度,生存率,条件', ...rows.map((r, i) => `S${i},${r.time},${r.conc.toFixed(2)},${r.surv === null ? '' : r.surv.toFixed(2)},${r.cond}`)].join('\n')
  );
  return { path, rows };
}

const { path: CULTURE, rows: CULTURE_ROWS } = makeCultureCsv();

/**
 * カードの各マーク（層）が今持っているデータの大きさ。点の層は行数、
 * 棒・ヒストグラムの層は件数（y）の合計。画面の見た目ではなく、描画に使われた
 * データそのものを見ることで、「選択が他のグラフに効いたか」を件数で確かめる。
 */
async function layerSizes(page: Page, type: string, n = 0): Promise<number[]> {
  return card(page, type, n).evaluate((el) => {
    const plot = (el.querySelector('.chart-body > .plot') as any)?.value;
    return plot.marks.map((m: any) => {
      const d = m.data;
      if (!d) return -1;
      if (m.type === 'rectY' || m.type === 'barY') {
        const y = d.columns?.y;
        return y ? Array.from(y as ArrayLike<number>).reduce((s: number, v) => s + Number(v), 0) : -1;
      }
      return d.numRows ?? d.length ?? -1;
    });
  });
}

/** カテゴリのグラフで、横軸のラベルが label のカテゴリをクリックする。 */
async function clickCategory(page: Page, type: string, label: string) {
  const c = card(page, type);
  await c.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const point = await c.evaluate((el, label) => {
    const svg = el.querySelector('.chart-body > .plot svg')!;
    const plot = (el.querySelector('.chart-body > .plot') as any).value;
    const tick = [...svg.querySelectorAll('text')].find((t) => t.textContent === label)!.getBoundingClientRect();
    const cx = tick.x + tick.width / 2;
    // クリックの受け手は toggleX が付いたマーク（誤差棒は見えない大きな点、棒グラフは母集団の棒）
    const target = plot.marks.findIndex((m: any) => m.type === 'dot' && m.channels.some((ch: any) => ch.channel === 'r' && ch.value === 22));
    const index = target >= 0 ? plot.marks[target].index : plot.marks[0].index;
    const shapes = [...svg.querySelectorAll(`g[data-index="${index}"] > *`)].map((s) => s.getBoundingClientRect());
    const best = shapes.sort((a, b) => Math.abs(a.x + a.width / 2 - cx) - Math.abs(b.x + b.width / 2 - cx))[0];
    return { x: best.x + best.width / 2, y: best.y + best.height - Math.min(8, best.height / 2) };
  }, label);
  await page.mouse.click(point.x, point.y);
}

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await loadCsv(page, CULTURE, 300);
});

test('列の型から初期のグラフを自動で並べる（数値2列は散布図、カテゴリ×数値は誤差棒）', async ({ page }) => {
  const titles = await page.locator('[data-chart-title]').allTextContents();
  expect(titles[0]).toMatch(/^散布図 — /);
  // 群間の差が最も大きいのは、条件で平均をずらした「濃度」
  expect(titles).toContain('平均±誤差棒 — 条件 × 濃度');
  expect(titles.filter((t) => t.startsWith('ヒストグラム'))).toHaveLength(2);
});

test('誤差棒のカテゴリをクリックすると、散布図とヒストグラムがその条件に絞られる', async ({ page }) => {
  const expected = CULTURE_ROWS.filter((r) => r.cond === '処理A').length;
  await clickCategory(page, 'errorbar', '処理A');
  await expect(page.locator('#conditionChips')).toContainText('選択: 条件 = 処理A');
  expect(await waitForSelection(page)).toBe(expected);

  // 散布図の色付きの層（2枚目のマーク）の行数、ヒストグラムの色付きの層の件数の合計
  await expect.poll(async () => (await layerSizes(page, 'scatter'))[1]).toBe(expected);
  await expect.poll(async () => (await layerSizes(page, 'histogram', 0))[1]).toBe(expected);
  await expect.poll(async () => (await layerSizes(page, 'histogram', 1))[1]).toBe(expected);
  // 誤差棒の色付きの層は、クリックした条件だけになる（残りは灰色のまま）
  expect((await layerSizes(page, 'errorbar'))[2]).toBe(1);

  // 何もない所をクリックすると解除
  const box = (await plotSvg(page, 'errorbar').boundingBox())!;
  await page.mouse.click(box.x + box.width - 5, box.y + 5);
  await expect(page.locator('#selectedCount')).toHaveText('—');
});

test('選んだ列の型で、選べるグラフの種類と Y の列が変わる', async ({ page }) => {
  await page.click('#addChart');
  const c = page.locator('.chart-card').last();
  const x = c.locator('[data-role="x"]');
  const y = c.locator('[data-role="y"]');
  const types = c.locator('[data-role="type"] option');

  await x.selectOption('条件');
  await y.selectOption('');
  await expect(types).toHaveText(['棒グラフ（件数）']);
  await y.selectOption('濃度');
  await expect(types).toHaveText(['平均±誤差棒', '棒グラフ（平均）']);
  // カテゴリ列は Y に選べない（意味のない組み合わせを出さない）
  await expect(y.locator('option')).not.toContainText(['条件']);

  // 整数の列（時間）を X にすると、順序として折れ線も選べる。小数の列では選べない
  await x.selectOption('時間');
  await y.selectOption('濃度');
  await expect(types).toHaveText(['散布図', '折れ線（平均）']);
  await x.selectOption('濃度');
  await y.selectOption('生存率');
  await expect(types).toHaveText(['散布図']);
  await y.selectOption('');
  await expect(types).toHaveText(['ヒストグラム']);
});

test('誤差は標準誤差が既定で、標準偏差に切り替えられる', async ({ page }) => {
  const axis = () => plotSvg(page, 'errorbar').locator('text', { hasText: '平均 ±' });
  await expect(axis()).toHaveText(/標準誤差/);
  await control(page, 'errorbar', 'error').selectOption('sd');
  await expect(axis()).toHaveText(/標準偏差/);
});

test('棒グラフ（件数）の棒をクリックして選べる', async ({ page }) => {
  await page.click('#addChart');
  const c = page.locator('.chart-card').last();
  await c.locator('[data-role="x"]').selectOption('条件');
  await c.locator('[data-role="y"]').selectOption('');
  await expect(c).toHaveAttribute('data-type', 'bar-count');
  await clickCategory(page, 'bar-count', '対照');
  expect(await waitForSelection(page)).toBe(CULTURE_ROWS.filter((r) => r.cond === '対照').length);
});

test('折れ線は横にドラッグして範囲を選べる', async ({ page }) => {
  await page.click('#addChart');
  const c = page.locator('.chart-card').last();
  await c.locator('[data-role="x"]').selectOption('時間');
  await c.locator('[data-role="y"]').selectOption('濃度');
  await c.locator('[data-role="type"]').selectOption('line');
  await expect(c).toHaveAttribute('data-type', 'line');
  await drag(page, plotSvg(page, 'line'), [0.2, 0.5], [0.5, 0.5]);
  await expect(page.locator('#conditionChips')).toContainText('選択: 時間');
  const selected = await waitForSelection(page);
  expect(selected).toBeGreaterThan(0);
  expect(selected).toBeLessThan(300);
});

test('グラフを追加・削除できる。削除したグラフの選択は解除され、他のグラフの選択は残る', async ({ page }) => {
  const before = await page.locator('.chart-card').count();
  await page.click('#addChart');
  await expect(page.locator('.chart-card')).toHaveCount(before + 1);

  // 誤差棒で条件を選び、ヒストグラムでも範囲を選ぶ（2つの選択が重なる）
  await clickCategory(page, 'errorbar', '処理B');
  await waitForSelection(page);
  await drag(page, plotSvg(page, 'histogram'), [0.1, 0.5], [0.9, 0.5]);
  await expect(page.locator('#conditionChips .chip-brush')).toHaveCount(2);

  // 誤差棒を削除すると、その選択（条件 = 処理B）だけが消える
  await card(page, 'errorbar').locator('[data-role="remove"]').click();
  await expect(page.locator('.chart-card[data-type="errorbar"]')).toHaveCount(0);
  await expect(page.locator('#conditionChips')).not.toContainText('条件 = 処理B');
  await expect(page.locator('#conditionChips .chip-brush')).toHaveCount(1);
});
