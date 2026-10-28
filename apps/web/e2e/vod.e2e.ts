import { type APIRequestContext, type Page, expect, test } from '@playwright/test';

/**
 * Films et séries dans le navigateur : fiche, lecture, sauts (dans le chargé et au-delà),
 * reprise depuis l'accueil et sur un autre appareil, épisode suivant, recherche globale,
 * coupure du portail pendant un film.
 */

const PORTAL_URL = process.env['E2E_FAKE_PORTAL_URL'] ?? 'http://127.0.0.1:18080';
const ADMIN_PASSWORD = process.env['E2E_ADMIN_PASSWORD'] ?? '';
const PORTAL_NAME = 'Films et séries';
/** Un film du portail factice dure 64 s (la boucle de mire, une fois). */
const MOVIE_S = 64;
/** Une image clé toutes les 2 s dans le fichier factice : un saut tombe à 2 s près. */
const KEYFRAME_S = 2;

test.describe.configure({ timeout: 240_000 });

interface Setup {
  portalId: string;
  movie: { id: string; name: string };
  series: { id: string };
  channel: { name: string };
}

async function login(request: APIRequestContext): Promise<void> {
  const res = await request.post('/api/auth/login', {
    data: { username: 'admin', password: ADMIN_PASSWORD },
  });
  expect(res.status()).toBe(204);
}

async function setup(request: APIRequestContext): Promise<Setup> {
  await login(request);
  const portals = (await (await request.get('/api/portals')).json()) as { id: string; name: string }[];
  let portalId = portals.find((p) => p.name === PORTAL_NAME)?.id;
  if (portalId === undefined) {
    const res = await request.post('/api/portals', {
      data: { name: PORTAL_NAME, url: `${PORTAL_URL}/stalker_portal/c/`, mac: '00:1A:79:00:F1:01' },
    });
    expect(res.status(), await res.text()).toBe(201);
    portalId = ((await res.json()) as { id: string }).id;
  }
  const complete = async (path: string): Promise<{ id: string; name: string }[]> => {
    let items: { id: string; name: string }[] = [];
    await expect
      .poll(
        async () => {
          const body = (await (await request.get(path)).json()) as {
            complete: boolean;
            items: { id: string; name: string; censored: boolean }[];
          };
          items = body.items.filter((i) => !i.censored);
          return body.complete;
        },
        { timeout: 90_000 },
      )
      .toBe(true);
    return items;
  };
  const movies = await complete(`/api/portals/${portalId}/movies`);
  const series = await complete(`/api/portals/${portalId}/series`);
  const channels = (await (await request.get(`/api/portals/${portalId}/channels`)).json()) as {
    channels: { name: string; censored: boolean }[];
  };
  return {
    portalId,
    movie: movies[0] ?? { id: '', name: '' },
    series: series[0] ?? { id: '', name: '' },
    channel: channels.channels.find((c) => !c.censored) ?? { name: '' },
  };
}

/**
 * Le portail factice fabrique le fichier d'un film à sa première demande (plusieurs secondes
 * de calcul) : une lecture d'échauffement, pour mesurer Lumen et non le faux portail.
 */
async function warmUp(request: APIRequestContext, portalId: string, movieId: string): Promise<void> {
  const res = await request.post('/api/vod/sessions', {
    data: { item: { kind: 'movie', portalId, movieId } },
  });
  expect(res.status(), await res.text()).toBe(201);
  const { sessionId } = (await res.json()) as { sessionId: string };
  await request.delete(`/api/vod/sessions/${sessionId}`);
}

/** Position dans le titre affichée par le lecteur (s). */
const position = async (page: Page): Promise<number> =>
  Number((await page.getByTestId('vod-player').getAttribute('data-position')) ?? '0');

/** Commandes visibles (elles s'escamotent après quelques secondes sans geste). */
async function showControls(page: Page): Promise<void> {
  await page.mouse.move(200, 200);
  await page.mouse.move(220, 210);
}

async function clickSeekbarAt(page: Page, ratio: number): Promise<void> {
  await showControls(page);
  const bar = page.getByTestId('vod-seekbar');
  const box = await bar.boundingBox();
  if (box === null) throw new Error('barre de lecture invisible');
  await bar.click({ position: { x: box.width * ratio, y: box.height / 2 } });
}

test('film : fiche, lecture, sauts, pause, reprise depuis l accueil puis sur un autre appareil', async ({
  page,
  browser,
}) => {
  const s = await setup(page.request);
  await warmUp(page.request, s.portalId, s.movie.id);

  await page.goto('/films');
  await expect(page.getByTestId('poster-tile').first()).toBeVisible({ timeout: 30_000 });

  await page.goto(`/films/${s.portalId}/${s.movie.id}`);
  await expect(page.getByTestId('movie-detail')).toContainText(s.movie.name);
  const clicked = Date.now();
  await page.getByTestId('play').click();
  await expect.poll(() => position(page), { timeout: 30_000 }).toBeGreaterThan(0.3);
  console.log(`film : première image ${Date.now() - clicked} ms après le clic`);
  await expect.poll(() => position(page), { timeout: 20_000 }).toBeGreaterThan(4);

  // En avant, dans ce que le serveur a déjà produit : déplacement immédiat.
  await clickSeekbarAt(page, 0.75);
  await expect.poll(() => position(page), { timeout: 15_000 }).toBeGreaterThan(MOVIE_S * 0.75 - KEYFRAME_S);
  const afterForward = await position(page);
  await page.waitForTimeout(3000);
  expect(await position(page)).toBeGreaterThan(afterForward + 2);

  // Loin en arrière : hors du chargé, une nouvelle lecture part de là.
  await clickSeekbarAt(page, 0.1);
  await expect
    .poll(async () => Math.abs((await position(page)) - MOVIE_S * 0.1), { timeout: 20_000 })
    .toBeLessThan(KEYFRAME_S + 1.5);
  const afterBack = await position(page);
  await page.waitForTimeout(3000);
  expect(await position(page)).toBeGreaterThan(afterBack + 2);

  // Pause : position enregistrée sur le serveur.
  await showControls(page);
  await page.getByTestId('vod-play-pause').click();
  const paused = await position(page);
  await expect
    .poll(
      async () => {
        const list = (await (await page.request.get('/api/progress')).json()) as {
          kind: string;
          portalId: string;
          itemId: string;
          positionS: number;
        }[];
        const p = list.find(
          (x) => x.kind === 'movie' && x.portalId === s.portalId && x.itemId === s.movie.id,
        );
        return p === undefined ? Number.POSITIVE_INFINITY : Math.abs(p.positionS - paused);
      },
      { timeout: 15_000 },
    )
    .toBeLessThan(1.5);

  // Accueil : « Reprendre », y compris après rechargement de la page.
  await page.goto('/');
  const row = page.getByTestId('continue-row');
  await expect(row).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByTestId('poster-tile').first().click();
  // Reprise quelques secondes avant l'arrêt, à l'image clé près.
  await expect.poll(() => position(page), { timeout: 30_000 }).toBeGreaterThan(paused - 5 - KEYFRAME_S - 1);
  expect(await position(page)).toBeLessThan(paused + 3);
  await page.goto('/');

  // Autre appareil du même compte : la reprise le suit.
  const other = await browser.newContext();
  try {
    const tablet = await other.newPage();
    await login(tablet.request);
    await tablet.goto(`/lire/film/${s.portalId}/${s.movie.id}`);
    await expect
      .poll(() => position(tablet), { timeout: 30_000 })
      .toBeGreaterThan(paused - 5 - KEYFRAME_S - 2);
  } finally {
    await other.close();
  }
});

test('série : saisons et épisodes, puis épisode suivant enchaîné à la fin', async ({ page }) => {
  const s = await setup(page.request);
  const detail = (await (
    await page.request.get(`/api/portals/${s.portalId}/series/${s.series.id}`)
  ).json()) as {
    seasons: { id: string }[];
  };
  const seasonId = detail.seasons[0]?.id ?? '';
  const episodes = (await (
    await page.request.get(
      `/api/portals/${s.portalId}/series/${s.series.id}/seasons/${encodeURIComponent(seasonId)}`,
    )
  ).json()) as { id: string }[];
  expect(episodes.length).toBeGreaterThan(1);

  await page.goto(`/series/${s.portalId}/${s.series.id}`);
  await expect(page.getByTestId('episode')).toHaveCount(episodes.length, { timeout: 30_000 });

  // Juste avant la fin du premier épisode.
  const e = encodeURIComponent;
  await page.goto(
    `/lire/episode/${s.portalId}/${s.series.id}/${e(seasonId)}/${e(episodes[0]?.id ?? '')}?t=56`,
  );
  await expect(page.getByTestId('next-episode')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: '▶ Lire maintenant' }).click();
  await expect(page).toHaveURL(new RegExp(`/lire/episode/.+/${e(episodes[1]?.id ?? '')}`));
  await expect.poll(() => position(page), { timeout: 30_000 }).toBeGreaterThan(1);
  expect(await position(page)).toBeLessThan(20);
});

test('recherche globale : chaînes, films et séries depuis un seul champ', async ({ page }) => {
  const s = await setup(page.request);
  await page.goto('/recherche');
  const field = page.getByLabel('Rechercher partout');
  await field.fill(s.movie.name);
  await expect(page.getByTestId('search-movies')).toContainText(s.movie.name, { timeout: 30_000 });
  await field.fill(s.channel.name);
  // Vue « Tous les portails » : le nom affiché est nettoyé (« CM | NOVA HD » → « NOVA ») ; on
  // y cherche le mot le plus long du nom saisi.
  const word = s.channel.name.split(/[^\p{L}\p{N}]+/u).reduce((a, b) => (b.length > a.length ? b : a), '');
  await expect(page.getByTestId('search-channels')).toContainText(new RegExp(word, 'i'), {
    timeout: 30_000,
  });
});

test('coupure du portail en plein film : l image ne s arrête pas', async ({ page }) => {
  const s = await setup(page.request);
  await warmUp(page.request, s.portalId, s.movie.id);
  // Débit limité, mais plus rapide que la lecture (comme un vrai portail) : le fichier se lit
  // encore quand la coupure survient, et le lecteur a pris de l'avance.
  await page.request.post(`${PORTAL_URL}/_chaos/throttle`, { data: { bitrateKbps: 20_000 } });
  try {
    await page.goto(`/lire/film/${s.portalId}/${s.movie.id}?t=0`);
    await expect.poll(() => position(page), { timeout: 30_000 }).toBeGreaterThan(1);
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const v = document.querySelector('video');
            if (v === null || v.buffered.length === 0) return 0;
            return v.buffered.end(v.buffered.length - 1) - v.currentTime;
          }),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(12);
    await page.request.post(`${PORTAL_URL}/_chaos/drop`, { data: { durationMs: 5000 } });
    const samples = await page.evaluate(async () => {
      const video = document.querySelector('video');
      const out: { t: number; at: number }[] = [];
      const started = performance.now();
      while (performance.now() - started < 15_000) {
        out.push({ t: video?.currentTime ?? 0, at: performance.now() });
        await new Promise((r) => setTimeout(r, 100));
      }
      return out;
    });
    let maxStallMs = 0;
    let since = samples[0]?.at ?? 0;
    for (let i = 1; i < samples.length; i++) {
      const cur = samples[i];
      const prev = samples[i - 1];
      if (cur === undefined || prev === undefined) continue;
      if (cur.t > prev.t) since = cur.at;
      else maxStallMs = Math.max(maxStallMs, cur.at - since);
    }
    const advanced = (samples.at(-1)?.t ?? 0) - (samples[0]?.t ?? 0);
    console.log(
      `coupure pendant un film : ${advanced.toFixed(1)} s lues en 15 s, arrêt max ${Math.round(maxStallMs)} ms`,
    );
    expect(maxStallMs).toBeLessThan(500);
    expect(advanced).toBeGreaterThan(13);
  } finally {
    await page.request.post(`${PORTAL_URL}/_chaos/reset`, { data: {} });
  }
});
