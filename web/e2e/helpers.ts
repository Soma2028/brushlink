// テスト共通の手順とテスト用 CSV の生成。

import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '.fixtures');

/** 画面の数字（"3,000" や "—"）を数値にする。数値でなければ null。 */
export function parseCount(text: string | null): number | null {
  const n = Number((text ?? '').replace(/,/g, '').trim());
  return (text ?? '').trim() === '' || Number.isNaN(n) ? null : n;
}

export async function countOf(page: Page, id: 'selectedCount' | 'populationCount' | 'totalCount') {
  return parseCount(await page.locator(`#${id}`).textContent());
}

/** ページを開き、DuckDB の初期化が終わってボタンが押せるようになるまで待つ。 */
export async function openApp(page: Page) {
  await page.goto('./');
  await expect(page.locator('#welcomeSample')).toBeEnabled({ timeout: 60_000 });
}

/** サンプルデータを読み込み、統計表が出るまで待つ。 */
export async function loadSample(page: Page) {
  await openApp(page);
  await page.click('#welcomeSample');
  await waitForDashboard(page, 3000);
}

/**
 * 読み込み後、チャートまで描き終わるのを待つ。件数は軸の自動選択（非同期）より
 * 先に表示されるので、件数だけ待ってドラッグすると、描画前や作り直し中の
 * チャートを掴んでしまう。チャートの状態表示（「〜行」）は描画の最後に出る。
 */
export async function waitForDashboard(page: Page, total: number) {
  await expect(page.locator('#totalCount')).toHaveText(total.toLocaleString('en-US'), { timeout: 60_000 });
  await expect(page.locator('#populationCount')).toHaveText(/\d/);
  await expect(page.locator('#chartStatus')).toContainText(`${total.toLocaleString('en-US')} 行`);
  await expect(page.locator('.chart-card .chart-body > .plot svg').first()).toBeVisible();
}

export async function loadCsv(page: Page, path: string, total: number) {
  await page.setInputFiles('#fileInput', path);
  await waitForDashboard(page, total);
}

/**
 * チャートの上をドラッグする。上部の件数バーは画面上端に固定されているので、
 * 対象を画面中央までスクロールしてから操作する（端にあるとバーの下に隠れ、
 * ドラッグがバーの上で起きてしまう）。座標は対象の幅・高さに対する割合。
 */
export async function drag(page: Page, target: Locator, from: [number, number], to: [number, number], steps = 12) {
  // 自作のグラフ（statCharts.ts）は集計が届くたびに svg ごと作り直すので、
  // スクロールしてから位置を測るまでの間に要素が差し替わることがある。
  // その場合は探し直す（ロケーターは毎回その時点の要素を指し直す）
  let box: { x: number; y: number; width: number; height: number } | null = null;
  for (let attempt = 0; attempt < 5 && !box; attempt++) {
    await target.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => {});
    box = await target.boundingBox().catch(() => null);
    if (!box) await page.waitForTimeout(200);
  }
  if (!box) throw new Error('ドラッグ対象が表示されていません');
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps });
  await page.mouse.up();
}

/** 指定した種類のグラフのカード（n 枚目、0 始まり）。 */
export const card = (page: Page, type: string, n = 0) => page.locator(`.chart-card[data-type="${type}"]`).nth(n);

// グラフ本体の svg。凡例の見本色（小さな svg）や入れ子の svg を拾わないよう、
// プロット要素の直下に限る
export const plotSvg = (page: Page, type: string, n = 0) => card(page, type, n).locator('.chart-body > .plot svg').first();
export const scatter = (page: Page) => plotSvg(page, 'scatter');
// 初期表示では散布図の X 軸の列のヒストグラムが最初のヒストグラム
export const histX = (page: Page) => plotSvg(page, 'histogram');

/**
 * 点のグラフの、色付きの層（選択中）の点の数。点のグラフは母集団（灰）→ 選択中
 * （色付き）の順に dot の層を重ねているので、2つ目の層の点を数える。
 */
export async function selectedDotCount(svg: Locator): Promise<number> {
  return svg.locator('g[aria-label="dot"]').nth(1).locator('circle').count();
}

/** カードの設定（X・Y・種類・色など）の select。 */
export const control = (page: Page, type: string, role: string, n = 0) => card(page, type, n).locator(`[data-role="${role}"]`);

/** 統計表の、指定した列の行。 */
export const statsRow = (page: Page, column: string) =>
  page.locator('.stats-table tbody tr').filter({ has: page.locator('th', { hasText: new RegExp(`^${column}`) }) });

/** 選択（ブラシ）が効いて、選択件数が数字になるまで待って返す。 */
export async function waitForSelection(page: Page): Promise<number> {
  await expect(page.locator('#selectedCount')).toHaveText(/^[\d,]+$/);
  // 集計系はドラッグが止まってから追従する（settle.ts）ので、統計表の比較列が出るまで待つ
  await expect(page.locator('.stats-table thead')).toContainText('選択外の平均');
  return (await countOf(page, 'selectedCount'))!;
}

// ---------------------------------------------------------------------------
// テスト用 CSV（乱数のシードを固定して毎回同じ内容にする）
// ---------------------------------------------------------------------------

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 数値2列（相関あり）＋カテゴリ1列＋欠測を含む数値1列の CSV を作る。
 * shift で値全体をずらせる（同じ列構成で中身だけ違うファイルを作るため）。
 */
export function makeCsv(name: string, rows: number, opts: { seed?: number; shift?: number; preamble?: string[] } = {}) {
  const path = join(FIXTURE_DIR, name);
  if (existsSync(path)) return path;
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const r = rng(opts.seed ?? 1);
  const shift = opts.shift ?? 0;
  const lines = [...(opts.preamble ?? []), 'group,a,b,c'];
  for (let i = 0; i < rows; i++) {
    const a = shift + (r() - 0.5) * 6;
    const b = a * 2 + (r() - 0.5) * 3;
    const c = r() < 0.05 ? '' : r().toFixed(3);
    lines.push(`${'xyz'[Math.floor(r() * 3)]},${a.toFixed(3)},${b.toFixed(3)},${c}`);
  }
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}
