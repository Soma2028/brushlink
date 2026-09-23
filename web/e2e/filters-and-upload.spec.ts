// 絞り込みパネルとファイル読み込み。過去に見つかった不具合の再発防止を含む。

import { test, expect } from '@playwright/test';
import { openApp, loadSample, loadCsv, countOf, makeCsv, drag, histX, statsRow, waitForSelection } from './helpers';

test('スライダーに触れただけでは母集団が減らない（最大値の行が落ちる不具合の再発防止）', async ({ page }) => {
  await loadSample(page);
  // 値を変えずに input イベントだけ発火させる。以前は浮動小数点の丸めで
  // 上限が1段手前になり、最大値の行が母集団から落ちていた
  for (const thumb of await page.locator('.dual-range input').all()) {
    await thumb.dispatchEvent('input');
  }
  await expect(page.locator('#populationCount')).toHaveText('3,000');
  await expect(page.locator('.filter-item.is-active')).toHaveCount(0);
});

test('数値の範囲とカテゴリで絞り込み、すべてリセットで元に戻る', async ({ page }) => {
  await loadSample(page);
  const low = page.locator('.dual-range input').first();
  await low.evaluate((el: HTMLInputElement) => {
    el.value = '100'; // 0〜200 の中央 = 値域の半分
    el.dispatchEvent(new Event('input'));
  });
  await expect.poll(() => countOf(page, 'populationCount')).toBeLessThan(3000);
  await expect(page.locator('#conditionChips')).toContainText('絞り込み: 温度');

  await page.locator('.filter-checkbox', { hasText: 'A' }).first().click();
  const afterCategory = await countOf(page, 'populationCount');

  await page.click('#filterReset');
  await expect(page.locator('#populationCount')).toHaveText('3,000');
  await expect(page.locator('.filter-item.is-active')).toHaveCount(0);
  expect(afterCategory).toBeLessThan(3000);
});

test('「欠測を含める」をオフにすると欠測行が母集団から外れる', async ({ page }) => {
  await loadSample(page);
  const toggle = page.locator('.filter-nulls-toggle', { hasText: '欠測' }).first();
  const missing = Number((await toggle.textContent())!.match(/欠測 ([\d,]+) 件/)![1].replace(/,/g, ''));
  await toggle.locator('input').uncheck();
  await expect(page.locator('#populationCount')).toHaveText((3000 - missing).toLocaleString('en-US'));
});

test('タイトル行・単位行のある CSV でもヘッダ行を推定し、クリックで選び直せる', async ({ page }) => {
  const path = makeCsv('with-preamble.csv', 200, { preamble: ['実験記録 2026-09', 'mm,mm,mm,mm'] });
  await openApp(page);
  await loadCsv(page, path, 200);
  await expect(page.locator('#uploadStatus')).toContainText('ヘッダ: 2 行目');
  await expect(page.locator('#xAxisSelect option')).toHaveText(['a', 'b', 'c']);

  // 別の行（0行目）をヘッダに選び直すと、その行を列名として読み込み直す
  await page.click('#previewDetails summary');
  await page.locator('input[name="headerRowChoice"][value="0"]').check();
  await expect(page.locator('#uploadStatus')).toContainText('ヘッダ: 0 行目');
});

test('同じ列構成の別ファイルに読み替えても、新しいデータで集計される', async ({ page }) => {
  // 2つ目は値を +100 ずらしてある。古いデータの集計が使い回されると平均が変わらない
  const first = makeCsv('same-schema-1.csv', 1000, { seed: 3 });
  const second = makeCsv('same-schema-2.csv', 1000, { seed: 4, shift: 100 });
  await openApp(page);

  await loadCsv(page, first, 1000);
  await drag(page, histX(page), [0.2, 0.5], [0.6, 0.5]);
  await waitForSelection(page);
  const firstMean = await statsRow(page, 'a').locator('td.strong').textContent();

  await loadCsv(page, second, 1000);
  await expect(page.locator('#selectedCount')).toHaveText('—');
  await drag(page, histX(page), [0.2, 0.5], [0.6, 0.5]);
  await waitForSelection(page);
  const secondMean = await statsRow(page, 'a').locator('td.strong').textContent();

  expect(Number(secondMean!.replace(/,/g, ''))).toBeGreaterThan(Number(firstMean!.replace(/,/g, '')) + 50);
});

test('対応していない形式のファイルは、理由を示して読み込まない', async ({ page }) => {
  await openApp(page);
  await page.setInputFiles('#fileInput', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await expect(page.locator('#uploadStatus')).toContainText('対応していないファイル形式');
  await expect(page.locator('#welcome')).toBeVisible();
});
