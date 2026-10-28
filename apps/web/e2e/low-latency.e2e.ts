import { type APIRequestContext, type Page, expect, test } from '@playwright/test';

/**
 * « Direct au plus près » (LL-HLS) : au choix du spectateur, chaîne par chaîne. En confort,
 * le lecteur joue ~20 s derrière le direct (les coupures sont absorbées) ; en LL-HLS, à 3–5 s
 * (PROJECT.md), et l'indicateur le montre.
 */

const PORTAL_URL = process.env['E2E_FAKE_PORTAL_URL'] ?? 'http://127.0.0.1:18080';
const ADMIN_PASSWORD = process.env['E2E_ADMIN_PASSWORD'] ?? '';
/** Relais chauffé assez longtemps pour que le confort puisse se placer à 20 s du direct. */
const WARM_UP_MS = 32_000;
const SETTLE_MS = 12_000;
const LL_MAX_LATENCY_S = 5;
const COMFORT_MIN_LATENCY_S = 15;

test.describe.configure({ timeout: 240_000 });

async function ensurePortal(api: APIRequestContext): Promise<string> {
  const list = (await (await api.get('/api/portals')).json()) as { id: string; name: string }[];
  const found = list.find((p) => p.name === 'Direct A');
  if (found !== undefined) return found.id;
  const res = await api.post('/api/portals', {
    data: { name: 'Direct A', url: `${PORTAL_URL}/stalker_portal/c/`, mac: '00:1A:79:00:11:01' },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function latency(page: Page): Promise<number> {
  const text = (await page.getByTestId('live-latency').textContent()) ?? '';
  const value = /−(\d+)\s*s/.exec(text)?.[1];
  if (value === undefined) throw new Error(`retard illisible : « ${text} »`);
  return Number(value);
}

test('confort à ~20 s, puis « direct au plus près » à 3–5 s du direct', async ({ page }) => {
  const login = await page.request.post('/api/auth/login', {
    data: { username: 'admin', password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(204);
  const portalId = await ensurePortal(page.request);
  const list = (await (await page.request.get(`/api/portals/${portalId}/channels`)).json()) as {
    channels: { id: string; censored: boolean }[];
  };
  // Une chaîne que les autres tests ne regardent pas.
  const channel = list.channels.filter((c) => !c.censored).at(-3)?.id ?? '';
  const warm = await page.request.post('/api/playback', { data: { portalId, channelId: channel } });
  expect(warm.status()).toBe(201);
  await page.waitForTimeout(WARM_UP_MS);

  await page.goto('/');
  await page.evaluate(() => {
    localStorage.removeItem('lumen.lowLatency');
  });
  await page.goto(`/regarder/${portalId}/${channel}`);
  await page.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) > 1, undefined, {
    timeout: 60_000,
  });
  await page.waitForTimeout(SETTLE_MS);
  const comfort = await latency(page);
  console.log(`retard en confort : ${comfort} s`);
  expect(comfort).toBeGreaterThanOrEqual(COMFORT_MIN_LATENCY_S);

  const toggle = page.getByRole('button', { name: /Direct au plus près/ });
  await page.mouse.move(10, 10);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) > 1, undefined, {
    timeout: 60_000,
  });
  await page.waitForTimeout(SETTLE_MS);
  const live = await latency(page);
  console.log(`retard en direct au plus près : ${live} s`);
  expect(live).toBeLessThanOrEqual(LL_MAX_LATENCY_S);
  expect(live).toBeGreaterThanOrEqual(2);

  // Le choix est mémorisé pour cette chaîne sur cet appareil.
  const saved = await page.evaluate(() => localStorage.getItem('lumen.lowLatency'));
  expect(saved).toContain(channel);
});
