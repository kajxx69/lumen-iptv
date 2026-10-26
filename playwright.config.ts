import { defineConfig } from '@playwright/test';

const FAKE_PORTAL_PORT = Number(process.env['FAKE_PORTAL_E2E_PORT'] ?? 18080);
// La première génération des mires FFmpeg prend quelques dizaines de secondes.
const WEB_SERVER_START_TIMEOUT_MS = 180_000;

export default defineConfig({
  testMatch: '**/e2e/**/*.e2e.ts',
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${FAKE_PORTAL_PORT}`,
  },
  projects: [{ name: 'fake-portal' }],
  webServer: {
    command: 'pnpm --filter @lumen/fake-portal start',
    url: `http://127.0.0.1:${FAKE_PORTAL_PORT}/_health`,
    reuseExistingServer: !process.env['CI'],
    timeout: WEB_SERVER_START_TIMEOUT_MS,
    env: { FAKE_PORTAL_PORT: String(FAKE_PORTAL_PORT), FAKE_PORTAL_HOST: '127.0.0.1' },
  },
});
