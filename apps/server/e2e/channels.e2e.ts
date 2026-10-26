import { expect, test } from '@playwright/test';

const FAKE_PORTAL_URL = process.env['E2E_FAKE_PORTAL_URL'] ?? 'http://127.0.0.1:18080';
const ADMIN_PASSWORD = process.env['E2E_ADMIN_PASSWORD'] ?? '';

/**
 * Critère de sortie de la phase 2 : un vrai navigateur, sur l'origine du backend, liste
 * les chaînes du portail. Aucun en-tête MAG, aucun CORS : tout passe par le backend.
 */
test('un navigateur liste les chaînes à travers le backend', async ({ page }) => {
  // Le travail réel prend ~4 s ; le démarrage à froid de Chromium peut en prendre 30 sur
  // une machine modeste (analyse antivirus des binaires).
  test.setTimeout(90_000);
  await page.goto('/');
  await expect(page).toHaveTitle('Lumen');

  const result = await page.evaluate(
    async ({ portalUrl, password }) => {
      const timings: Record<string, number> = {};
      let mark = performance.now();
      const lap = (name: string): void => {
        timings[name] = Math.round(performance.now() - mark);
        mark = performance.now();
      };
      const json = { 'Content-Type': 'application/json' };
      const login = await fetch('/api/auth/login', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ username: 'admin', password }),
      });
      lap('connexion');
      const portals = (await (await fetch('/api/portals')).json()) as { id: string }[];
      let portalId = portals[0]?.id;
      if (portalId === undefined) {
        const created = await fetch('/api/portals', {
          method: 'POST',
          headers: json,
          body: JSON.stringify({
            name: 'Démo',
            url: `${portalUrl}/stalker_portal/c/`,
            mac: '00:1A:79:00:E2:E0',
          }),
        });
        portalId = ((await created.json()) as { id: string }).id;
      }
      lap('ajout du portail');
      const res = await fetch(`/api/portals/${portalId}/channels`);
      const body = (await res.json()) as { channels: { name: string }[] };
      lap('premier chargement (synchronisation)');
      const cached = await fetch(`/api/portals/${portalId}/channels`);
      await cached.json();
      lap('chargement en cache');
      return {
        login: login.status,
        status: res.status,
        count: body.channels.length,
        first: body.channels[0]?.name,
        timings,
      };
    },
    { portalUrl: FAKE_PORTAL_URL, password: ADMIN_PASSWORD },
  );

  console.log('durées (ms) :', JSON.stringify(result.timings));
  expect(result.login).toBe(204);
  expect(result.status).toBe(200);
  expect(result.count).toBe(5000);
  expect(result.first).toMatch(/\|/);

  // Le cookie de session est inaccessible au JavaScript de la page.
  expect(await page.evaluate(() => document.cookie)).toBe('');
});
