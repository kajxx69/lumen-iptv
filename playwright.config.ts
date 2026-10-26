import { randomBytes } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';

const FAKE_PORTAL_PORT = Number(process.env['FAKE_PORTAL_E2E_PORT'] ?? 18080);
const SERVER_PORT = Number(process.env['LUMEN_E2E_PORT'] ?? 18090);
const FAKE_PORTAL_URL = `http://127.0.0.1:${FAKE_PORTAL_PORT}`;
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
// La première génération des mires FFmpeg prend quelques dizaines de secondes.
const WEB_SERVER_START_TIMEOUT_MS = 180_000;
// Secrets jetables, propres à cette exécution. La configuration est réévaluée dans chaque
// processus de test : on ne tire la valeur qu'une fois, les autres l'héritent.
process.env['E2E_ADMIN_PASSWORD'] ??= randomBytes(12).toString('hex');
process.env['E2E_FAKE_PORTAL_URL'] = FAKE_PORTAL_URL;
const ADMIN_PASSWORD = process.env['E2E_ADMIN_PASSWORD'];

export default defineConfig({
  fullyParallel: false,
  reporter: [['list']],
  projects: [
    {
      name: 'fake-portal',
      testMatch: 'tools/fake-portal/e2e/**/*.e2e.ts',
      use: { baseURL: FAKE_PORTAL_URL },
    },
    {
      name: 'server',
      testMatch: 'apps/server/e2e/**/*.e2e.ts',
      use: { ...devices['Desktop Chrome'], baseURL: SERVER_URL },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @lumen/fake-portal start',
      url: `${FAKE_PORTAL_URL}/_health`,
      reuseExistingServer: !process.env['CI'],
      timeout: WEB_SERVER_START_TIMEOUT_MS,
      env: { FAKE_PORTAL_PORT: String(FAKE_PORTAL_PORT), FAKE_PORTAL_HOST: '127.0.0.1' },
    },
    {
      command: 'pnpm --filter @lumen/server start',
      url: `${SERVER_URL}/api/health`,
      reuseExistingServer: false,
      timeout: WEB_SERVER_START_TIMEOUT_MS,
      env: {
        LUMEN_HOST: '127.0.0.1',
        LUMEN_PORT: String(SERVER_PORT),
        LUMEN_DATABASE_PATH: ':memory:',
        LUMEN_MASTER_KEY: randomBytes(32).toString('base64'),
        LUMEN_ADMIN_PASSWORD: ADMIN_PASSWORD,
        LUMEN_COOKIE_SECURE: 'false',
        LUMEN_LOG_LEVEL: 'warn',
      },
    },
  ],
});
