// 機械学習タブ・列の書き戻し・図の書き出し・大規模データ（raster）・狭い画面。

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openApp, loadSample, loadCsv, makeCsv, drag, scatter, histX, waitForSelection, card, control } from './helpers';

test('クラスタ分析を列として追加すると、散布図がクラスタで色分けされる', async ({ page }) => {
  await loadSample(page);
  await page.click('[role=tab][data-tab=cluster]');
  await expect(page.locator('#clusterPanel')).toContainText('つのクラスタ');
  await page.click('#clusterPanel .ml-apply');
  await expect(control(page, 'scatter', 'color')).toHaveValue('クラスタ');
  // 欠測で割り当てられない行は null ではなく名前付きのカテゴリになる
  await expect(card(page, 'scatter').locator('.legend-wrap')).toContainText('（欠測あり）');
});

test('主成分を軸にした後も、そのチャートでドラッグ選択できる', async ({ page }) => {
  await loadSample(page);
  await page.click('[role=tab][data-tab=pca]');
  await expect(page.locator('#pcaPanel')).toContainText('寄与率');
  await page.click('#pcaPanel .ml-apply');
  await expect(control(page, 'scatter', 'x')).toHaveValue('主成分1');
  await expect(control(page, 'scatter', 'y')).toHaveValue('主成分2');

  // 主成分は散布図の軸になる（ヒストグラムは元の列のまま）。散布図の上で選ぶ
  await drag(page, scatter(page), [0.3, 0.3], [0.7, 0.7]);
  await waitForSelection(page);
  await expect(page.locator('#conditionChips')).toContainText('選択: 主成分1');
});

test('変数重要度は選択が必要で、選択に使った列を除いて順位付けする', async ({ page }) => {
  await loadSample(page);
  await page.click('[role=tab][data-tab=importance]');
  await expect(page.locator('#importancePanel')).toContainText('ドラッグして範囲を選ぶと');

  await drag(page, scatter(page), [0.55, 0.45], [0.95, 0.9]);
  await waitForSelection(page);
  const panel = page.locator('#importancePanel');
  await expect(panel.locator('.imp-row').first()).toBeVisible();
  await expect(panel).toContainText('精度');
  // 散布図の軸（厚み・強度）は選択に使った列なので、順位に入らない
  await expect(panel.locator('.imp-label')).not.toContainText(['厚み']);
  await expect(panel.locator('.imp-label')).not.toContainText(['強度']);
});

test('図を PNG / SVG で保存でき、SVG には条件の注記が入る', async ({ page }) => {
  await loadSample(page);
  await drag(page, scatter(page), [0.55, 0.45], [0.95, 0.9]);
  const selected = await waitForSelection(page);

  const [png] = await Promise.all([page.waitForEvent('download'), page.click('#exportPng')]);
  expect(png.suggestedFilename()).toMatch(/^brushlink-\d{8}-\d{4}\.png$/);
  const pngBytes = readFileSync((await png.path())!);
  expect(pngBytes.subarray(1, 4).toString()).toBe('PNG');

  const [svg] = await Promise.all([page.waitForEvent('download'), page.click('#exportSvg')]);
  const svgText = readFileSync((await svg.path())!, 'utf8');
  expect(svgText).toContain(`選択中 ${selected.toLocaleString('en-US')} 件`);
  expect(svgText).toContain('選択: 厚み');
  expect(svgText).toContain('散布図 — 厚み × 強度');
});

test('1.5万行以上は密度表示（raster）になり、色分けは無効になる', async ({ page }) => {
  const path = makeCsv('large-20k.csv', 20_000, { seed: 9 });
  await openApp(page);
  await loadCsv(page, path, 20_000);
  await expect(page.locator('#chartStatus')).toContainText('密度表示');
  await expect(control(page, 'scatter', 'color')).toBeDisabled();

  await drag(page, histX(page), [0.3, 0.5], [0.6, 0.5]);
  const selected = await waitForSelection(page);
  expect(selected).toBeGreaterThan(0);
  expect(selected).toBeLessThan(20_000);
});

test.describe('狭い画面（スマートフォン幅）', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('横スクロールが出ない', async ({ page }) => {
    await loadSample(page);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(390);
  });
});
