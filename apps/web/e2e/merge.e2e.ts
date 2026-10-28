import { type APIRequestContext, type Page, expect, test } from '@playwright/test';

/**
 * Fusion multi-portails dans l'interface. Les deux portails factices nomment les mêmes
 * chaînes différemment (A : « FR | NOVA TV FHD », B : « Nova TV France 1080 ») ; la vue
 * « Tous les portails » doit n'en montrer qu'une, la lire, et se laisser corriger.
 */

const PORTAL_A_URL = process.env['E2E_FAKE_PORTAL_URL'] ?? 'http://127.0.0.1:18080';
const PORTAL_B_URL = process.env['E2E_FAKE_PORTAL_B_URL'] ?? 'http://127.0.0.1:18081';
const ADMIN_PASSWORD = process.env['E2E_ADMIN_PASSWORD'] ?? '';
/** Les chaînes de B : les 50 premières de A. */
const CHANNELS_B = 50;

test.describe.configure({ mode: 'serial', timeout: 180_000 });

interface MergedChannel {
  id: string;
  name: string;
  censored: boolean;
  sources?: { portalId: string; channelId: string; name: string }[];
}

async function ensurePortal(api: APIRequestContext, name: string, url: string, mac: string): Promise<string> {
  const list = (await (await api.get('/api/portals')).json()) as { id: string; name: string }[];
  const found = list.find((p) => p.name === name);
  if (found !== undefined) return found.id;
  const res = await api.post('/api/portals', { data: { name, url: `${url}/stalker_portal/c/`, mac } });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function setup(page: Page): Promise<{ portalA: string; portalB: string; merged: MergedChannel[] }> {
  const login = await page.request.post('/api/auth/login', {
    data: { username: 'admin', password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(204);
  const portalA = await ensurePortal(page.request, 'Fusion A', PORTAL_A_URL, '00:1A:79:00:F0:01');
  const portalB = await ensurePortal(page.request, 'Fusion B', PORTAL_B_URL, '00:1A:79:00:F0:02');
  const merged = (
    (await (await page.request.get('/api/portals/all/channels')).json()) as { channels: MergedChannel[] }
  ).channels;
  await page.goto('/');
  // Choix vierge sur cet appareil : la vue par défaut doit être « Tous les portails ».
  await page.evaluate(() => {
    localStorage.removeItem('lumen.portal');
  });
  return { portalA, portalB, merged };
}

test('vue « Tous les portails » : par défaut, une chaîne par entrée, lue avec ses sources', async ({
  page,
}) => {
  const { portalA, portalB, merged } = await setup(page);
  // Les 50 chaînes de B ont toutes retrouvé leur jumelle sur A malgré des noms différents.
  // (D'autres tests du même serveur ajoutent leurs propres portails : d'autres sources encore.)
  const has = (c: MergedChannel, portalId: string): boolean =>
    (c.sources ?? []).some((s) => s.portalId === portalId);
  const shared = merged.filter((c) => has(c, portalB));
  expect(shared).toHaveLength(CHANNELS_B);
  expect(shared.every((c) => has(c, portalA))).toBe(true);

  const channel = shared.find((c) => !c.censored);
  if (channel === undefined) throw new Error('aucune chaîne commune visible');
  await page.goto('/tv');
  await expect(page.getByRole('button', { name: /Tous les portails/ })).toBeVisible({ timeout: 30_000 });
  await page.getByPlaceholder('Rechercher une chaîne ou un numéro').fill(channel.name);
  const rows = page.getByTestId('channel-row').filter({ hasText: channel.name });
  // Une seule ligne pour la chaîne, quel que soit le nombre de portails qui la proposent.
  await expect(rows).toHaveCount(1);
  await rows.first().click();
  await expect(page).toHaveURL(/\/regarder\/all\//);
  await page.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) > 1, undefined, {
    timeout: 60_000,
  });
  // Le portail qui sert l'image est nommé, les autres sources attendent en secours.
  await expect(page.getByTestId('source-indicator')).toContainText(/· \d+ secours prêts?/);
});

test('correction manuelle depuis les Réglages : séparer une source, puis annuler', async ({ page }) => {
  const { portalB, merged } = await setup(page);
  const channel = merged.find((c) => !c.censored && (c.sources ?? []).some((s) => s.portalId === portalB));
  if (channel === undefined) throw new Error('aucune chaîne commune visible');
  const count = async (): Promise<number> =>
    ((await (await page.request.get('/api/portals/all/channels')).json()) as { channels: unknown[] }).channels
      .length;
  const before = await count();

  await page.goto('/reglages');
  await page.getByLabel('Corriger un regroupement : chercher une chaîne').fill(channel.name);
  const group = page.locator('.merge-group', { hasText: channel.name }).first();
  await group.getByRole('button', { name: 'Séparer' }).last().click();
  await expect(page.getByText('mise à part')).toBeVisible();
  expect(await count()).toBe(before + 1);

  await page.getByRole('button', { name: 'Annuler la correction' }).click();
  await expect(page.getByText('mise à part')).toHaveCount(0);
  expect(await count()).toBe(before);
});
