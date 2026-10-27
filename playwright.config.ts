import { randomBytes } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';

const FAKE_PORTAL_PORT = Number(process.env['FAKE_PORTAL_E2E_PORT'] ?? 18080);
// Second portail : source de secours des tests de bascule.
const FAKE_PORTAL_B_PORT = Number(process.env['FAKE_PORTAL_B_E2E_PORT'] ?? 18081);
const SERVER_PORT = Number(process.env['LUMEN_E2E_PORT'] ?? 18090);
const FAKE_PORTAL_URL = `http://127.0.0.1:${FAKE_PORTAL_PORT}`;
const FAKE_PORTAL_B_URL = `http://127.0.0.1:${FAKE_PORTAL_B_PORT}`;
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
// Première génération des mires FFmpeg, ou construction de l'interface sur une machine chargée.
const WEB_SERVER_START_TIMEOUT_MS = 300_000;
// Secrets jetables, propres à cette exécution. La configuration est réévaluée dans chaque
// processus de test : on ne tire la valeur qu'une fois, les autres l'héritent.
process.env['E2E_ADMIN_PASSWORD'] ??= randomBytes(12).toString('hex');
process.env['E2E_FAKE_PORTAL_URL'] = FAKE_PORTAL_URL;
process.env['E2E_FAKE_PORTAL_B_URL'] = FAKE_PORTAL_B_URL;
const ADMIN_PASSWORD = process.env['E2E_ADMIN_PASSWORD'];
process.env['E2E_METRICS_TOKEN'] ??= randomBytes(16).toString('hex');
const METRICS_TOKEN = process.env['E2E_METRICS_TOKEN'];

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
      testMatch: ['apps/server/e2e/**/*.e2e.ts', 'apps/web/e2e/**/*.e2e.ts'],
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
      command: 'pnpm --filter @lumen/fake-portal start',
      url: `${FAKE_PORTAL_B_URL}/_health`,
      reuseExistingServer: !process.env['CI'],
      timeout: WEB_SERVER_START_TIMEOUT_MS,
      env: {
        FAKE_PORTAL_PORT: String(FAKE_PORTAL_B_PORT),
        FAKE_PORTAL_HOST: '127.0.0.1',
        FAKE_PORTAL_SEED: '2',
        FAKE_PORTAL_NAME: 'Lumen Fake Portal B',
        FAKE_PORTAL_CHANNEL_COUNT: '50',
      },
    },
    {
      // L'interface est construite puis servie par le backend, comme en production.
      command: 'pnpm --filter @lumen/web build && pnpm --filter @lumen/server start',
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
        // Le test « 50 spectateurs » lit la charge CPU du serveur sur /metrics, et ouvre ses
        // 50 lectures avec un seul compte : plafonds par compte relevés pour lui.
        LUMEN_METRICS_TOKEN: METRICS_TOKEN,
        LUMEN_MAX_STREAMS_PER_USER: '60',
        LUMEN_MAX_STREAMS_TOTAL: '80',
        LUMEN_API_REQUESTS_PER_MINUTE: '20000',
      },
    },
  ],
});
