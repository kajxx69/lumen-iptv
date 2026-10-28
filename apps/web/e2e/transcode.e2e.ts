import { expect, test } from '@playwright/test';

/**
 * Transcodage dans le navigateur : le portail C diffuse en MPEG-2 + AC-3, que Chromium ne
 * décode pas. La chaîne doit pourtant jouer, et l'indicateur dire qu'elle est convertie.
 */

const PORTAL_C_URL = process.env['E2E_FAKE_PORTAL_C_URL'] ?? 'http://127.0.0.1:18082';
const ADMIN_PASSWORD = process.env['E2E_ADMIN_PASSWORD'] ?? '';

test.describe.configure({ timeout: 180_000 });

test('chaîne MPEG-2 + AC-3 : convertie à la volée, lue, signalée', async ({ page }) => {
  const login = await page.request.post('/api/auth/login', {
    data: { username: 'admin', password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(204);
  const list = (await (await page.request.get('/api/portals')).json()) as { id: string; name: string }[];
  let portalId = list.find((p) => p.name === 'Diffusion MPEG-2')?.id;
  if (portalId === undefined) {
    const res = await page.request.post('/api/portals', {
      data: { name: 'Diffusion MPEG-2', url: `${PORTAL_C_URL}/stalker_portal/c/`, mac: '00:1A:79:00:C0:01' },
    });
    expect(res.status(), await res.text()).toBe(201);
    portalId = ((await res.json()) as { id: string }).id;
  }
  const channels = (await (await page.request.get(`/api/portals/${portalId}/channels`)).json()) as {
    channels: { id: string; censored: boolean }[];
  };
  const channel = channels.channels.find((c) => !c.censored)?.id ?? '';
  // La même chaîne existe en H.264 sur les autres portails du serveur de test : la fusion la
  // lirait là, sans conversion. Mise à part, elle n'a que sa source MPEG-2.
  const solo = await page.request.put('/api/catalog/merge/overrides', {
    data: { portalId, channelId: channel, target: 'solo' },
  });
  expect(solo.status()).toBe(200);

  await page.goto(`/regarder/${portalId}/${channel}`);
  await page.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) > 2, undefined, {
    timeout: 60_000,
  });
  await expect(page.getByTestId('source-indicator')).toContainText(/image convertie/);
  // L'image avance vraiment : le navigateur décode le H.264 produit par le serveur.
  const t1 = await page.evaluate(() => document.querySelector('video')?.currentTime ?? 0);
  await page.waitForTimeout(4000);
  const t2 = await page.evaluate(() => document.querySelector('video')?.currentTime ?? 0);
  expect(t2 - t1).toBeGreaterThan(3);
  // Image réellement décodée : la mire de test, dessinée sur un canevas, est en couleurs.
  // (Un navigateur sans affichage ne compte pas les images présentées : on regarde les pixels.)
  const colours = await page.evaluate(() => {
    const v = document.querySelector('video');
    if (v === null || v.videoWidth === 0) return 0;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return 0;
    ctx.drawImage(v, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const seen = new Set<number>();
    for (let i = 0; i < data.length; i += 4 * 97) {
      seen.add(((data[i] ?? 0) >> 5) * 64 + ((data[i + 1] ?? 0) >> 5) * 8 + ((data[i + 2] ?? 0) >> 5));
    }
    return seen.size;
  });
  console.log(`teintes distinctes dans l'image décodée : ${colours}`);
  expect(colours).toBeGreaterThan(8);
  await page.request.put('/api/catalog/merge/overrides', {
    data: { portalId, channelId: channel, target: null },
  });
});
