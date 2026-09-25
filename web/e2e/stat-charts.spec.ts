// 統計用のグラフ（相関行列・Q-Q・バイオリン・散布図行列・残差）と
// 階層クラスタリング。どれも $brush / $filter に参加して連動することを確かめる。

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { loadSample, card, control, plotSvg, drag, waitForSelection, countOf, selectedDotCount } from './helpers';

/** 最後のカードの X・Y・種類を設定する（「グラフを追加」した直後に使う）。 */
async function addChart(page: Page, x: string, y: string | null, type: string) {
  await page.click('#addChart');
  const c = page.locator('.chart-card').last();
  await c.locator('[data-role="x"]').selectOption(x);
  if (y !== null) await c.locator('[data-role="y"]').selectOption(y);
  await c.locator('[data-role="type"]').selectOption(type);
  await expect(page.locator(`.chart-card[data-type="${type}"]`).first()).toBeVisible();
}

/** 自作グラフの svg（凡例の svg は除く）。 */
const statSvg = (page: Page, type: string) => card(page, type).locator('.stat-chart svg').last();

/** 画面中央までスクロールしてから、要素の中の相対位置を座標でクリックする。 */
async function clickAt(page: Page, loc: ReturnType<Page['locator']>, fx: number, fy: number) {
  await loc.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const b = (await loc.boundingBox())!;
  await page.mouse.click(b.x + b.width * fx, b.y + b.height * fy);
}

test.beforeEach(async ({ page }) => {
  await loadSample(page);
});

test('列の型に応じて、統計用のグラフが種類に出る', async ({ page }) => {
  await page.click('#addChart');
  const c = page.locator('.chart-card').last();
  const types = c.locator('[data-role="type"] option');
  await c.locator('[data-role="x"]').selectOption('__all_numeric__');
  await expect(types).toHaveText(['相関行列', '散布図行列']);
  // 「数値列すべて」では Y を選ばない
  await expect(c.locator('[data-role="y"]')).toHaveCount(0);
  await c.locator('[data-role="x"]').selectOption('強度');
  await c.locator('[data-role="y"]').selectOption('');
  await expect(types).toHaveText(['ヒストグラム', 'Q-Q プロット']);
  await c.locator('[data-role="y"]').selectOption('厚み');
  await expect(types).toHaveText(['散布図', '回帰の残差プロット']);
  await c.locator('[data-role="x"]').selectOption('ライン');
  await c.locator('[data-role="y"]').selectOption('強度');
  await expect(types).toHaveText(['平均±誤差棒', 'バイオリン図', '棒グラフ（平均）']);
});

test('相関行列のセルをクリックすると、散布図の X・Y がその2列になる', async ({ page }) => {
  await addChart(page, '__all_numeric__', null, 'corr');
  const cells = card(page, 'corr').locator('g[aria-label="cell"] rect');
  await expect(cells).toHaveCount(36); // 数値6列 × 6列
  // 2枚目のセル = （温度, 湿度）
  await clickAt(page, cells.nth(1), 0.5, 0.5);
  await expect(control(page, 'scatter', 'x')).toHaveValue('温度');
  await expect(control(page, 'scatter', 'y')).toHaveValue('湿度');
});

test('Q-Q プロットを縦にドラッグすると、値の範囲で選択され他のグラフが絞られる', async ({ page }) => {
  await addChart(page, '強度', '', 'qq');
  const svg = statSvg(page, 'qq');
  await expect(svg).toBeVisible();
  await drag(page, svg, [0.5, 0.2], [0.5, 0.55]);
  await expect(page.locator('#conditionChips')).toContainText('選択: 強度');
  const selected = await waitForSelection(page);
  expect(selected).toBeGreaterThan(0);
  expect(selected).toBeLessThan(3000);
  // 散布図の色付きの層（選択中）も同じ件数に絞られている
  await expect
    .poll(() => card(page, 'scatter').evaluate((el) => (el.querySelector('.chart-body > .plot') as any).value.marks[1].data.numRows))
    .toBe(selected);
});

test('バイオリン図はクリックでカテゴリ、縦のドラッグで値の範囲を選べる', async ({ page }) => {
  await addChart(page, 'ライン', '強度', 'violin');
  const svg = statSvg(page, 'violin');
  await expect(svg.locator('text', { hasText: /^C$/ })).toBeVisible();
  // ライン C は横軸の右端（3つのうち3番目）
  await clickAt(page, svg, 0.83, 0.45);
  await expect(page.locator('#conditionChips')).toContainText('選択: ライン = C');
  const selected = await waitForSelection(page);
  expect(selected).toBeGreaterThan(500);
  expect(selected).toBeLessThan(1500);
  // もう一度クリックで解除
  await clickAt(page, svg, 0.83, 0.45);
  await expect(page.locator('#conditionChips')).not.toContainText('ライン = C');

  await drag(page, svg, [0.5, 0.3], [0.5, 0.6]);
  await expect(page.locator('#conditionChips')).toContainText('選択: 強度');
});

test('散布図行列は5列までで、それを超える列はチェックで選び直せる。どのマスでも選択できる', async ({ page }) => {
  await addChart(page, '__all_numeric__', null, 'splom');
  const c = card(page, 'splom');
  // サンプルの数値列は6列。上限5列を超えるので、並べる列を選ぶ欄が出る
  await expect(c.locator('[data-role="splom-col"]')).toHaveCount(6);
  await expect(c.locator('[data-role="splom-col"]:checked')).toHaveCount(5);
  await expect(c.locator('.splom-cell')).toHaveCount(25);
  // 温度を外して不良率を入れる
  await c.locator('[data-role="splom-col"][value="温度"]').uncheck();
  await expect(c.locator('.splom-cell')).toHaveCount(16);
  await c.locator('[data-role="splom-col"][value="不良率"]').check();
  await expect(c.locator('.splom-cell')).toHaveCount(25);
  await expect(c.locator('[data-chart-title]')).toContainText('不良率');
  await expect(c.locator('[data-chart-title]')).not.toContainText('温度');

  // 左上から2番目のマス（対角以外）でドラッグ
  const cell = c.locator('.splom-cell').nth(1).locator('svg').first();
  await drag(page, cell, [0.2, 0.2], [0.8, 0.8]);
  const selected = await waitForSelection(page);
  expect(selected).toBeGreaterThan(0);
});

test('残差プロットで四角くドラッグすると選択できる', async ({ page }) => {
  await addChart(page, '厚み', '強度', 'residual');
  await drag(page, plotSvg(page, 'residual'), [0.2, 0.1], [0.8, 0.5]);
  const selected = await waitForSelection(page);
  expect(selected).toBeGreaterThan(0);
  expect(selected).toBeLessThan(3000);
  // 残差プロット自身でも、枠の中の点だけが色付きで残る
  await expect.poll(() => selectedDotCount(plotSvg(page, 'residual'))).toBe(selected);
});

test('選択の結果が0行になっても、密度表示（raster）のグラフでエラーにならない', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  // 3,000 行 × 対角以外 20 マス ≥ 15,000 なので、散布図行列は raster で描かれる
  await addChart(page, '__all_numeric__', null, 'splom');
  await addChart(page, '強度', '', 'qq');
  // 同じ列（強度）で重ならない2つの範囲を選ぶ → 必ず0行になる
  // （強度のヒストグラムで低い側、Q-Q で高い側）
  await drag(page, plotSvg(page, 'histogram', 1), [0.2, 0.5], [0.35, 0.5]);
  await drag(page, statSvg(page, 'qq'), [0.5, 0.02], [0.5, 0.15]);
  await expect(page.locator('#selectedCount'), (await page.textContent('#conditionChips')) ?? '').toHaveText('0');
  await page.waitForTimeout(1000);
  expect(errors).toEqual([]);
});

test.describe('階層クラスタリング', () => {
  test.beforeEach(async ({ page }) => {
    await page.click('[role=tab][data-tab=hclust]');
  });

  test('上限を超える行は間引いて実行し、何件から何件に減らしたかを出す。クラスタ列が色分け・絞り込みに加わる', async ({ page }) => {
    await page.click('.hc-run');
    const status = page.locator('#hclustPanel .ml-status');
    // サンプルは 3,000 行、うち欠測の無い行 2,682 行を上限の 800 行に間引く
    await expect(status).toContainText('2,682 件から 800 件に減らして実行');
    await expect(status).toContainText('Ward 法');
    await expect(page.locator('.hc-svg')).toBeVisible();
    const clusters = await page.locator('.cluster-chip').count();
    expect(clusters).toBeGreaterThanOrEqual(2);
    await expect(control(page, 'scatter', 'color')).toHaveValue('階層クラスタ');
    await expect(page.locator('.filter-name', { hasText: '階層クラスタ' })).toBeVisible();

    // クラスタ数を変えると列も書き直され、絞り込みの選択肢も変わる
    await page.selectOption('.hc-k', '4');
    await expect(page.locator('.cluster-chip')).toHaveCount(4);
    const filter = page.locator('.filter-item', { has: page.locator('.filter-name', { hasText: '階層クラスタ' }) });
    await expect(filter.locator('.filter-checkbox')).toHaveCount(5); // 4クラスタ + （欠測あり）
  });

  test('クラスタをクリックすると選択され、他のグラフが絞られる。絞り込みにも使える', async ({ page }) => {
    await page.click('.hc-run');
    await expect(page.locator('.hc-svg')).toBeVisible();
    await page.locator('.cluster-chip').first().click();
    await expect(page.locator('#conditionChips')).toContainText('選択: 階層クラスタ = 階層クラスタ1');
    const selected = await waitForSelection(page);
    expect(selected).toBeGreaterThan(0);
    // 選択した行がヒートマップの横の帯に印として出る
    await expect(page.locator('.hc-svg path[stroke="#2563eb"]')).toHaveCount(1);
    await page.keyboard.press('Escape');

    // 絞り込みで「階層クラスタ1」だけにする
    const filter = page.locator('.filter-item', { has: page.locator('.filter-name', { hasText: '階層クラスタ' }) });
    await filter.locator('.link-button').click(); // 全解除
    await filter.locator('.filter-checkbox', { hasText: '階層クラスタ1' }).click();
    await expect.poll(() => countOf(page, 'populationCount')).toBe(selected);
  });

  test('連結法と標準化を切り替えられ、標準化をやめると注記が出る。選択中の行だけでも実行できる', async ({ page }) => {
    await expect(page.locator('.hc-standardize-note')).toBeHidden();
    await page.uncheck('.hc-standardize');
    await expect(page.locator('.hc-standardize-note')).toBeVisible();
    await expect(page.locator('.hc-standardize-note')).toContainText('単位');
    await page.selectOption('.hc-method', 'average');
    // 選択が無いうちは「選択中の行だけ」は選べない
    // <option> の disabled は toBeDisabled では判定されないので、プロパティで確かめる
    await expect(page.locator('.hc-scope option[value="selected"]')).toHaveJSProperty('disabled', true);
    await drag(page, plotSvg(page, 'histogram'), [0.3, 0.5], [0.6, 0.5]);
    const selected = await waitForSelection(page);
    await expect(page.locator('.hc-scope option[value="selected"]')).toHaveJSProperty('disabled', false);
    await page.selectOption('.hc-scope', 'selected');
    await page.click('.hc-run');
    const status = page.locator('#hclustPanel .ml-status');
    await expect(status).toContainText('対象: 選択中の行');
    await expect(status).toContainText('平均連結法');
    await expect(status).toContainText('標準化なし');
    // 選択中の欠測の無い行が上限（800 件）以下ならそのまま、超えれば間引いて実行する
    await expect(status).toContainText(/件で実行|件から 800 件に減らして実行/);
    expect(selected).toBeGreaterThan(0);
  });
});
