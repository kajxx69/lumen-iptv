import { type APIRequestContext, type Page, expect, test } from '@playwright/test';

/**
 * Lecture avancée dans le navigateur : sous-titres (piste du fichier, fichier de l'appareil,
 * décalage), pistes audio, zapping préparé, rattrapage (début du programme, pause prolongée
 * du direct reprise dans l'archive, retour au direct).
 */

const PORTAL_URL = process.env['E2E_FAKE_PORTAL_URL'] ?? 'http://127.0.0.1:18080';
const ADMIN_PASSWORD = process.env['E2E_ADMIN_PASSWORD'] ?? '';
const PORTAL_NAME = 'Lecture avancée';
/** Le portail factice sert un film sur quatre en MKV : deux langues, deux sous-titres. */
const MULTILINGUAL_EVERY = 4;
/** « Réplique n » commence à 4 × (n − 1) s et dure 3 s (portail factice). */
const CUE_INTERVAL_S = 4;
const HOUR_MS = 3_600_000;

test.describe.configure({ timeout: 240_000 });

async function setup(request: APIRequestContext): Promise<string> {
  const login = await request.post('/api/auth/login', {
    data: { username: 'admin', password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(204);
  const portals = (await (await request.get('/api/portals')).json()) as { id: string; name: string }[];
  const existing = portals.find((p) => p.name === PORTAL_NAME)?.id;
  if (existing !== undefined) return existing;
  const res = await request.post('/api/portals', {
    data: { name: PORTAL_NAME, url: `${PORTAL_URL}/stalker_portal/c/`, mac: '00:1A:79:00:A0:01' },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function multilingualMovies(request: APIRequestContext, portalId: string): Promise<string[]> {
  let ids: string[] = [];
  await expect
    .poll(
      async () => {
        const body = (await (await request.get(`/api/portals/${portalId}/movies`)).json()) as {
          complete: boolean;
          items: { id: string; censored: boolean }[];
        };
        ids = body.items
          .filter((m) => !m.censored && Number(m.id) % MULTILINGUAL_EVERY === 0)
          .map((m) => m.id);
        return body.complete;
      },
      { timeout: 90_000 },
    )
    .toBe(true);
  return ids;
}

const position = async (page: Page): Promise<number> =>
  Number((await page.getByTestId('vod-player').getAttribute('data-position')) ?? '0');

async function showControls(page: Page): Promise<void> {
  await page.mouse.move(200, 200);
  await page.mouse.move(220, 210);
}

/** Bouton de sous-titres actionné jusqu'au libellé voulu. */
async function chooseSubtitles(page: Page, label: RegExp): Promise<void> {
  const button = page.getByTestId('vod-subtitles');
  for (let i = 0; i < 6; i++) {
    await showControls(page);
    if (label.test((await button.textContent()) ?? '')) return;
    await button.click();
  }
  await expect(button).toHaveText(label);
}

test('film multilingue : sous-titres à leur place, langue audio, fichier de l appareil, décalage', async ({
  page,
}) => {
  const portalId = await setup(page.request);
  const [first, second] = await multilingualMovies(page.request, portalId);
  expect(second).toBeDefined();

  await page.goto(`/lire/film/${portalId}/${first ?? ''}?t=0`);
  await expect.poll(() => position(page), { timeout: 60_000 }).toBeGreaterThan(1);

  // Sous-titres français du fichier : la réplique affichée correspond à la position.
  await chooseSubtitles(page, /Français/);
  const subtitle = page.getByTestId('subtitle-text');
  await expect(subtitle).toHaveText(/^Réplique \d+$/, { timeout: 20_000 });
  const shown = Number(/\d+/.exec((await subtitle.textContent()) ?? '')?.[0]);
  const at = await position(page);
  expect(Math.abs(shown - (Math.floor(at / CUE_INTERVAL_S) + 1))).toBeLessThanOrEqual(1);

  // Langue audio : la lecture repart dans l'autre langue, sans quitter l'écran.
  await showControls(page);
  await page.getByTestId('vod-audio').click();
  await showControls(page);
  await expect(page.getByTestId('vod-audio')).toHaveText(/Anglais/, { timeout: 30_000 });
  const before = await position(page);
  await page.waitForTimeout(3000);
  expect(await position(page)).toBeGreaterThan(before + 1.5);

  // Fichier de sous-titres de l'appareil, puis décalage d'une demi-seconde.
  await page.getByTestId('subtitle-file').setInputFiles({
    name: 'perso.srt',
    mimeType: 'application/x-subrip',
    buffer: Buffer.from('1\n00:00:00,000 --> 01:00:00,000\nBonjour Lumen\n'),
  });
  await expect(subtitle).toHaveText('Bonjour Lumen', { timeout: 10_000 });
  await showControls(page);
  await page.getByRole('button', { name: 'Sous-titres plus tard' }).click();
  await expect(page.getByTestId('subtitle-delay')).toHaveText(/\+0,5 s/);

  // Film suivant : la langue de sous-titres choisie (français) est retrouvée.
  await page.goto(`/lire/film/${portalId}/${second ?? ''}?t=0`);
  await expect.poll(() => position(page), { timeout: 60_000 }).toBeGreaterThan(1);
  await showControls(page);
  await expect(page.getByTestId('vod-subtitles')).toHaveText(/Français/, { timeout: 20_000 });
  await expect(subtitle).toHaveText(/^Réplique \d+$/, { timeout: 20_000 });
});

/**
 * Le direct joue : si le navigateur a refusé la lecture automatique, le bouton « Lancer la
 * lecture » est actionné, comme le ferait le spectateur.
 */
async function livePlaying(page: Page, minS: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const start = page.getByRole('button', { name: '▶ Lancer la lecture' });
        if (await start.isVisible()) await start.click();
        return page.evaluate(() => document.querySelector('video')?.currentTime ?? 0);
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThan(minS);
}

/** Chaîne du portail avec une archive, et le programme qu'elle diffuse. */
async function archivedChannel(
  request: APIRequestContext,
  portalId: string,
): Promise<{ id: string; programme: { start: number; end: number } }> {
  const list = (await (await request.get(`/api/portals/${portalId}/channels`)).json()) as {
    channels: { id: string; archiveHours: number; censored: boolean }[];
  };
  const now = Date.now();
  for (const c of list.channels.filter((x) => x.archiveHours > 0 && !x.censored)) {
    const epg = (await (
      await request.get(
        `/api/portals/${portalId}/channels/${c.id}/epg?from=${now - HOUR_MS}&to=${now + HOUR_MS}`,
      )
    ).json()) as { start: number; end: number; catchup: boolean }[];
    // Programme commencé depuis plus de 3 minutes : de quoi revenir en arrière.
    const airing = epg.find((e) => e.catchup && e.start <= now - 3 * 60_000 && now < e.end - 60_000);
    if (airing !== undefined) return { id: c.id, programme: airing };
  }
  throw new Error('aucune chaîne archivée avec un programme en cours');
}

test('direct : chaînes voisines préparées, début du programme, retour au direct', async ({ page }) => {
  const portalId = await setup(page.request);
  const channel = await archivedChannel(page.request, portalId);

  const prefetch = page.waitForRequest(
    (r) => r.url().endsWith('/api/playback/prefetch') && r.method() === 'POST',
  );
  await page.goto(`/regarder/${portalId}/${channel.id}`);
  const body = (await prefetch).postDataJSON() as { channels: { channelId: string }[] };
  expect(body.channels.length).toBeGreaterThan(0);
  expect(body.channels.some((c) => c.channelId === channel.id)).toBe(false);

  await livePlaying(page, 1);
  await page.mouse.move(200, 200);
  await page.getByTestId('restart-programme').click();
  await expect(page).toHaveURL(/\/lire\/archive\//);
  await expect.poll(() => position(page), { timeout: 60_000 }).toBeGreaterThan(1);
  expect(await position(page)).toBeLessThan(30);
  await showControls(page);
  await expect(page.getByTestId('vod-label')).toContainText(/différé de \d+ min/);
  await page.getByTestId('back-to-live').click();
  await expect(page).toHaveURL(new RegExp(`/regarder/${portalId}/${channel.id}$`));
});

test('pause prolongée du direct : la lecture reprend dans l archive, à l instant de la pause', async ({
  page,
}) => {
  const portalId = await setup(page.request);
  const channel = await archivedChannel(page.request, portalId);
  await page.goto(`/regarder/${portalId}/${channel.id}`);
  await livePlaying(page, 2);
  // Retard sur le direct au moment de la pause, tel que le lecteur l'affiche.
  await page.mouse.move(200, 200);
  const latencyText = (await page.getByTestId('live-latency').textContent({ timeout: 10_000 })) ?? '';
  const latencyS = Number(/(\d+)\s*s/.exec(latencyText)?.[1] ?? '0');
  const pausedAt = Date.now();
  await page.evaluate(() => document.querySelector('video')?.pause());
  // Bien plus long que ce que le serveur garde du direct (30 s) : l'image figée n'y est plus.
  await page.waitForTimeout(45_000);
  await page.evaluate(() => void document.querySelector('video')?.play());
  await expect(page).toHaveURL(/\/lire\/archive\//, { timeout: 15_000 });
  await expect.poll(() => position(page), { timeout: 60_000 }).toBeGreaterThan(0.5);
  // Reprise là où l'image s'était figée : l'instant de la pause, moins le retard affiché.
  const expected = (pausedAt - channel.programme.start) / 1000 - latencyS;
  expect(Math.abs((await position(page)) - expected)).toBeLessThan(10);
});
