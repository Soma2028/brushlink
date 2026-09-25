// クロスフィルタの中核: 読み込み → ドラッグ選択 → 件数・統計・回帰・要約の連動。

import { test, expect } from '@playwright/test';
import { loadSample, countOf, drag, scatter, histX, waitForSelection, parseCount, card, control, selectedDotCount } from './helpers';

test.beforeEach(async ({ page }) => {
  await loadSample(page);
});

test('サンプルを読み込むと、軸が自動で選ばれ、未選択の案内が出る', async ({ page }) => {
  expect(await countOf(page, 'populationCount')).toBe(3000);
  // 相関が最も強い2列が自動で軸になる（サンプルは厚みと強度に強い負の相関を仕込んである）
  await expect(control(page, 'scatter', 'x')).toHaveValue('厚み');
  await expect(control(page, 'scatter', 'y')).toHaveValue('強度');
  await expect(page.locator('#insightCard')).toContainText('ドラッグして');
  await expect(page.locator('#selectedCount')).toHaveText('—');
  await expect(page.locator('#clearSelection')).toBeDisabled();
});

test('散布図をドラッグすると、件数・要約・統計・回帰が連動する', async ({ page }) => {
  await drag(page, scatter(page), [0.55, 0.45], [0.95, 0.9]);
  const selected = await waitForSelection(page);
  expect(selected).toBeGreaterThan(0);
  expect(selected).toBeLessThan(3000);

  await expect(page.locator('#conditionChips')).toContainText('選択: 厚み');
  await expect(page.locator('#insightCard')).toContainText(`選んだ ${selected.toLocaleString('en-US')} 件`);
  // 選択に使った列は「選択に使用」の印が付き、要約からは除かれる
  await expect(page.locator('.stats-table')).toContainText('選択に使用');
  await expect(page.locator('#insightCard')).toContainText('選択に使った列');

  // 回帰の n は選択件数と1件単位で一致する（Mosaic の事前集計による
  // ピクセル丸めで 847 と 848 がずれた不具合の再発防止）
  const regression = card(page, 'scatter').locator('.chart-regression');
  await expect(regression).toContainText('選択中');
  const nValues = await regression.locator('.reg-detail').allTextContents();
  const selectedN = parseCount(nValues[1].match(/n = ([\d,]+)/)![1]);
  // 散布図の範囲選択は X・Y 両方の範囲条件なので、軸の列が欠測の行は
  // 選択に入らない。よって回帰の n は選択件数とちょうど一致するはず
  expect(selectedN).toBe(selected);
});

test('散布図をドラッグすると、その散布図自身でも枠の中の点だけが色付きで残る', async ({ page }) => {
  // 以前は crossfilter の仕様で、自分で囲んだ範囲が自分の点に効かず、
  // 全部の点が色付きのままで枠でしか選択が分からなかった
  const before = await selectedDotCount(scatter(page));
  expect(before).toBeGreaterThan(2000);
  await drag(page, scatter(page), [0.55, 0.45], [0.95, 0.9]);
  const selected = await waitForSelection(page);
  await expect.poll(() => selectedDotCount(scatter(page))).toBe(selected);
  // 選択外の点も灰色の層に残っている（全体の中のどこを選んだかが見える）
  expect(await scatter(page).locator('g[aria-label="dot"]').first().locator('circle').count()).toBe(before);

  // 解除すると全部の点が色付きに戻る
  await page.keyboard.press('Escape');
  await expect.poll(() => selectedDotCount(scatter(page))).toBe(before);
});

test('ヒストグラムのドラッグでも選択でき、Esc と解除ボタンで解除できる', async ({ page }) => {
  await drag(page, histX(page), [0.25, 0.5], [0.55, 0.5]);
  await waitForSelection(page);
  await expect(page.locator('#clearSelection')).toBeEnabled();

  await page.keyboard.press('Escape');
  await expect(page.locator('#selectedCount')).toHaveText('—');
  await expect(page.locator('#conditionChips')).not.toContainText('選択:');

  await drag(page, histX(page), [0.25, 0.5], [0.55, 0.5]);
  await waitForSelection(page);
  await page.click('#clearSelection');
  await expect(page.locator('#selectedCount')).toHaveText('—');
});

test('軸を変えると選択が解除される（見えない選択が残らない）', async ({ page }) => {
  await drag(page, scatter(page), [0.55, 0.45], [0.95, 0.9]);
  await waitForSelection(page);
  await control(page, 'scatter', 'x').selectOption('温度');
  await expect(page.locator('#selectedCount')).toHaveText('—');
  await expect(page.locator('#conditionChips')).not.toContainText('選択:');
});

test('カテゴリ構成タブで、選択中と選択外の構成比と χ² 検定が出る', async ({ page }) => {
  await drag(page, scatter(page), [0.55, 0.45], [0.95, 0.9]);
  await waitForSelection(page);
  await page.click('[role=tab][data-tab=categories]');
  const panel = page.locator('#categoryPanel');
  await expect(panel).toContainText('選択中');
  await expect(panel).toContainText('選択外');
  await expect(panel).toContainText('χ² 検定');
});

test('行データタブに選択中の行が出る', async ({ page }) => {
  await drag(page, scatter(page), [0.55, 0.45], [0.95, 0.9]);
  await waitForSelection(page);
  await page.click('[role=tab][data-tab=rows]');
  await expect(page.locator('.rows-table tbody tr').first()).toBeVisible();
  expect(await page.locator('.rows-table thead th').count()).toBe(9);
});

test('絞り込みでカテゴリが減っても、各カテゴリの色は変わらない', async ({ page }) => {
  // 凡例の見本色を、カテゴリ名 → 色 で読む
  const legendColors = () =>
    card(page, 'scatter').locator('.legend-wrap').evaluate((root) => {
      const colors: Record<string, string> = {};
      root.querySelectorAll('svg').forEach((svg) => {
        const label = svg.parentElement?.textContent?.trim() ?? '';
        const fill = (svg.querySelector('[fill]') ?? svg).getAttribute('fill') ?? '';
        if (label) colors[label] = fill;
      });
      return colors;
    });
  await expect(control(page, 'scatter', 'color')).toHaveValue('ライン');
  const before = await legendColors();
  expect(Object.keys(before)).toEqual(['A', 'B', 'C']);

  // ライン A を外すと、以前は B・C が色を振り直されて C の色が変わっていた
  await page.locator('.filter-checkbox', { hasText: 'A' }).first().click();
  await expect(page.locator('#conditionChips')).toContainText('絞り込み: ライン');
  const after = await legendColors();
  expect(after.C).toBe(before.C);
  expect(after.B).toBe(before.B);
});

test('ウィンドウの幅を変えると、選択を保ったままチャートが幅に合わせて描き直される', async ({ page }) => {
  await drag(page, scatter(page), [0.55, 0.45], [0.95, 0.9]);
  const selected = await waitForSelection(page);
  const chips = await page.locator('#conditionChips').textContent();
  const widthBefore = (await scatter(page).boundingBox())!.width;

  // 置き場所が狭くなると、グラフのカードは2列から1列に並び替わり、
  // 散布図はカードの幅いっぱいに描き直される（chartGrid.ts の resize）
  await page.setViewportSize({ width: 1100, height: 1100 });
  const bodyWidth = () => card(page, 'scatter').locator('.chart-body').evaluate((el) => el.clientWidth);
  await expect.poll(async () => (await scatter(page).boundingBox())!.width).not.toBe(widthBefore);
  await expect.poll(async () => Math.abs((await scatter(page).boundingBox())!.width - (await bodyWidth()))).toBeLessThan(2);
  const histBox = (await histX(page).boundingBox())!;
  expect(histBox.y).toBeGreaterThan((await scatter(page).boundingBox())!.y + 100);

  // 作り直していないので、選択と件数はそのまま残る
  expect(await countOf(page, 'selectedCount')).toBe(selected);
  await expect(page.locator('#conditionChips')).toHaveText(chips!);
  // ブラシの枠（d3-brush の .selection）も新しい大きさの上に描き直されている
  const brushRect = scatter(page).locator('rect.selection');
  await expect(brushRect).toBeVisible();
  expect(Number(await brushRect.getAttribute('width'))).toBeGreaterThan(10);
});
