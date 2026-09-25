// 重回帰のタブ。DuckDB で集計した平均・共分散から係数を解く経路と、
// 母集団・選択中の2本の当てはめが選択に連動することを確かめる。

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApp, loadSample, loadCsv, drag, scatter, waitForSelection, parseCount } from './helpers';

const panel = (page: Page) => page.locator('#mregPanel');
const rowOf = (page: Page, label: string) =>
  panel(page).locator('.mreg-table tbody tr').filter({ has: page.locator('th', { hasText: new RegExp(`^${label}`) }) });

async function openTab(page: Page) {
  await page.click('[role=tab][data-tab=mreg]');
  await expect(panel(page).locator('.mreg-table')).toBeVisible();
}

test('目的変数は散布図の Y が初期値で、他の数値列を説明変数にして当てはめる', async ({ page }) => {
  await loadSample(page);
  await openTab(page);
  await expect(panel(page).locator('[data-role="mreg-target"]')).toHaveValue('強度');
  await expect(panel(page).locator('[data-role="mreg-x"]:checked')).toHaveCount(5);
  await expect(panel(page).locator('.mreg-table tbody tr:not(.mreg-fit)')).toHaveCount(5);
  await expect(panel(page).locator('.ml-summary')).toContainText('「強度」のばらつきの');
  // 選ぶ前は母集団の列だけ
  await expect(panel(page).locator('.mreg-table thead')).not.toContainText('選択中');

  // 説明変数を外すと行が減り、目的変数を変えると選択肢から外れる
  await panel(page).locator('[data-role="mreg-x"][value="温度"]').uncheck();
  await expect(panel(page).locator('.mreg-table tbody tr:not(.mreg-fit)')).toHaveCount(4);
  await panel(page).locator('[data-role="mreg-target"]').selectOption('不良率');
  await expect(panel(page).locator('.ml-summary')).toContainText('「不良率」のばらつきの');
  await expect(panel(page).locator('[data-role="mreg-x"][value="不良率"]')).toHaveCount(0);
});

test('グラフで選ぶと選択中の当てはめが並び、選択に使った列に印が付く', async ({ page }) => {
  await loadSample(page);
  await openTab(page);
  await drag(page, scatter(page), [0.55, 0.45], [0.95, 0.9]);
  const selected = await waitForSelection(page);
  await expect(panel(page).locator('.mreg-table thead')).toContainText('選択中');
  await expect(rowOf(page, '厚み')).toContainText('選択に使用');
  // 目的変数（強度）の範囲でも選んでいるので、偏りの注意が出る
  await expect(panel(page)).toContainText('目的変数「強度」の範囲で選んでいる');
  // 選択中の n は、欠測の行を除くので選択件数以下
  const nCells = await rowOf(page, 'n').locator('td.num').allTextContents();
  const selN = parseCount(nCells[1])!;
  expect(selN).toBeGreaterThan(0);
  expect(selN).toBeLessThanOrEqual(selected);

  // 解除すると母集団だけに戻る
  await page.keyboard.press('Escape');
  await expect(panel(page).locator('.mreg-table thead')).not.toContainText('選択中');
});

test('ぴったり線形なデータで係数を正しく求め、他の列の和で表せる列は理由を示して外す', async ({ page }) => {
  // y = 1 + 2a − 3b（誤差なし）。d = a + b は a と b で完全に表せる
  const dir = join(dirname(fileURLToPath(import.meta.url)), '.fixtures');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'mreg-exact.csv');
  const lines = ['a,b,d,y'];
  for (let i = 0; i < 200; i++) {
    const a = (i * 37) % 101;
    const b = (i * 53) % 89;
    lines.push(`${a},${b},${a + b},${1 + 2 * a - 3 * b}`);
  }
  writeFileSync(path, lines.join('\n') + '\n');

  await openApp(page);
  await loadCsv(page, path, 200);
  await openTab(page);
  await panel(page).locator('[data-role="mreg-target"]').selectOption('y');
  await expect(panel(page).locator('[data-role="mreg-x"]:checked')).toHaveCount(3);
  await expect(panel(page)).toContainText('d（他の説明変数の組み合わせで表せる）');
  await expect(rowOf(page, 'a').locator('td.num').first()).toHaveText('2');
  await expect(rowOf(page, 'b').locator('td.num').first()).toHaveText('-3');
  await expect(rowOf(page, '切片').locator('td.num').first()).toHaveText('1');
  await expect(rowOf(page, 'R²')).toContainText('1.000');
});
