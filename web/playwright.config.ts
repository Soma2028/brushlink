// ブラウザ駆動の自動テスト（Playwright）の設定。
//
// クロスフィルタは「ドラッグしたら他のチャートと数値が変わる」ことが本質で、
// 関数単位のテストでは確かめられないため、実際のブラウザで本番ビルドを操作する。
// 本番ビルド（vite build → vite preview）を対象にするのは、Web Worker の
// バンドルや base パス（/brushlink/）など、開発サーバでは再現しない部分まで
// 確かめるため。
//
// 注意: DuckDB-WASM 本体は初回に jsDelivr から取得するので、ネットワークが必要。

import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
  testDir: './e2e',
  // DuckDB-WASM の取得と初期化に数秒かかるので、既定の30秒では足りないことがある
  timeout: 90_000,
  expect: { timeout: 20_000 },
  // 1つのページで重いクエリを流すテストが多く、並列にすると CPU の取り合いで
  // 時間依存の待ちが不安定になるため、直列で回す
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}/brushlink/`,
    viewport: { width: 1440, height: 1100 },
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1100 } } },
    // Safari / Firefox での動作確認用（npm run test:e2e:all で実行）
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 1100 } } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1440, height: 1100 } } },
  ],
  webServer: {
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/brushlink/`,
    // 既に立っているサーバを使い回すと、ソースを変えても古い dist のまま
    // テストしてしまう（実際に一度それで誤った失敗を見た）。毎回ビルドし直す
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
