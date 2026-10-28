import { type APIRequestContext, type Page, expect, test } from '@playwright/test';

/**
 * Adaptation au réseau (PROJECT.md) : la qualité suit le débit réel du spectateur, sans
 * coupure ; l'économie de données part d'emblée en basse qualité ; une coupure totale de la
 * connexion se rattrape seule.
 */

const PORTAL_URL = process.env['E2E_FAKE_PORTAL_URL'] ?? 'http://127.0.0.1:18080';
const ADMIN_PASSWORD = process.env['E2E_ADMIN_PASSWORD'] ?? '';
/** Débit du spectateur bridé : bien moins que la source (≈ 1,4 Mbit/s), assez pour le 360p. */
const THROTTLED_KBPS = 700;

test.describe.configure({ mode: 'serial', timeout: 240_000 });

async function ensurePortal(api: APIRequestContext): Promise<string> {
  const list = (await (await api.get('/api/portals')).json()) as { id: string; name: string }[];
  const found = list.find((p) => p.name === 'Réseau A');
  if (found !== undefined) return found.id;
  const res = await api.post('/api/portals', {
    data: { name: 'Réseau A', url: `${PORTAL_URL}/stalker_portal/c/`, mac: '00:1A:79:00:AE:01' },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** Une chaîne que nul autre test ne regarde, mise à part : seule sa source compte. */
async function setup(page: Page, index: number, quality: Record<string, unknown> | null): Promise<string> {
  const login = await page.request.post('/api/auth/login', {
    data: { username: 'admin', password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(204);
  const portalId = await ensurePortal(page.request);
  const list = (await (await page.request.get(`/api/portals/${portalId}/channels`)).json()) as {
    channels: { id: string; censored: boolean }[];
  };
  const channel = list.channels.filter((c) => !c.censored).at(-(10 + index))?.id ?? '';
  await page.goto('/');
  await page.evaluate((q) => {
    localStorage.removeItem('lumen.lowLatency');
    if (q === null) localStorage.removeItem('lumen.quality');
    else localStorage.setItem('lumen.quality', JSON.stringify(q));
  }, quality);
  await page.goto(`/regarder/${portalId}/${channel}`);
  await page.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) > 1, undefined, {
    timeout: 60_000,
  });
  return channel;
}

const position = (page: Page): Promise<number> =>
  page.evaluate(() => document.querySelector('video')?.currentTime ?? 0);

test('débit du spectateur divisé : la qualité descend seule, la lecture reste fluide', async ({ page }) => {
  await setup(page, 0, null);
  await expect(page.getByTestId('quality-indicator')).toContainText('Source');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 40,
    downloadThroughput: (THROTTLED_KBPS * 1000) / 8,
    uploadThroughput: (THROTTLED_KBPS * 1000) / 8,
  });
  // Le contrôle automatique descend d'un palier à chaque constat (arrêt, débit trop juste).
  await expect(page.getByTestId('quality-indicator')).toContainText('360p', { timeout: 150_000 });
  const t1 = await position(page);
  await page.waitForTimeout(20_000);
  const advanced = (await position(page)) - t1;
  console.log(`après la descente à 360p : ${advanced.toFixed(1)} s lues en 20 s`);
  expect(advanced).toBeGreaterThan(18);
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
});

test('économie de données : la lecture part d emblée en basse qualité', async ({ page }) => {
  await setup(page, 1, { wifi: 'source', cellular: 'medium', unknown: 'source', dataSaver: true });
  await expect(page.getByTestId('quality-indicator')).toContainText('360p', { timeout: 30_000 });
});

test('coupure totale de la connexion : reprise automatique au retour', async ({ page, context }) => {
  await setup(page, 2, null);
  await context.setOffline(true);
  await page.waitForTimeout(8000);
  await context.setOffline(false);
  const t1 = await position(page);
  await page.waitForFunction((from) => (document.querySelector('video')?.currentTime ?? 0) > from + 5, t1, {
    timeout: 30_000,
  });
  await expect(page.locator('.player-message[role=alert]')).toHaveCount(0);
});
