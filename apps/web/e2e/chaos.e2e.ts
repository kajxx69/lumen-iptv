import { type APIRequestContext, type Page, expect, test } from '@playwright/test';

/**
 * Suite de chaos de PROJECT.md : dix scénarios, chacun mesurant l'expérience réelle du
 * spectateur dans le navigateur (image figée, indicateur de chargement, message d'erreur,
 * source active), jamais l'état interne du code.
 *
 * Deux portails factices : A (graine 1, 5 000 chaînes) et B (graine 2, 50 chaînes). Une
 * même chaîne y porte des identifiants différents mais le même identifiant EPG : c'est au
 * moteur de trouver B comme source de secours, le test ne la fournit jamais.
 */

const PORTAL_A_URL = process.env['E2E_FAKE_PORTAL_URL'] ?? 'http://127.0.0.1:18080';
const PORTAL_B_URL = process.env['E2E_FAKE_PORTAL_B_URL'] ?? 'http://127.0.0.1:18081';
const ADMIN_PASSWORD = process.env['E2E_ADMIN_PASSWORD'] ?? '';
const METRICS_TOKEN = process.env['E2E_METRICS_TOKEN'] ?? '';
const NAME_A = 'Chaos A';
const NAME_B = 'Chaos B';
/** Chaînes présentes sur B : les 50 premières de A (même contenu, même identifiant EPG). */
const SHARED_CHANNELS = 50;

/** Critères PROJECT.md. */
const MAX_SWITCH_MS = 2000;
const MAX_FREEZE_DETECTION_MS = 2500;
/** Une image arrêtée moins longtemps ne se voit pas (une ou deux images manquées). */
const INVISIBLE_STALL_MS = 500;

// Scénarios indépendants : un échec n'empêche pas de mesurer les suivants.
test.describe.configure({ timeout: 300_000 });

interface Ctx {
  portalA: string;
  portalB: string;
  /**
   * Portails servis par le portail factice B : « Chaos B », mais aussi ceux qu'ont ajoutés
   * les autres tests du même serveur. La fusion les réunit tous en sources d'une même
   * chaîne ; basculer sur l'un d'eux, c'est échapper à la panne de A.
   */
  bSide: Set<string>;
  /** Chaînes de A qui existent aussi sur B (source de secours possible). */
  paired: string[];
  /** Chaînes de A sans équivalent sur B. */
  alone: string[];
}

let ctx: Ctx | null = null;

async function chaos(baseUrl: string, scenario: string, body: Record<string, unknown> = {}): Promise<void> {
  const res = await fetch(`${baseUrl}/_chaos/${scenario}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`chaos ${scenario} : HTTP ${res.status}`);
}

async function resetChaos(): Promise<void> {
  await chaos(PORTAL_A_URL, 'reset');
  await chaos(PORTAL_B_URL, 'reset');
}

async function ensurePortal(api: APIRequestContext, name: string, url: string, mac: string): Promise<string> {
  const list = (await (await api.get('/api/portals')).json()) as { id: string; name: string }[];
  const found = list.find((p) => p.name === name);
  if (found !== undefined) return found.id;
  const res = await api.post('/api/portals', { data: { name, url: `${url}/stalker_portal/c/`, mac } });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** Connexion, portails A et B enregistrés, A affiché ; choix des chaînes de test. */
async function setup(page: Page): Promise<Ctx> {
  const login = await page.request.post('/api/auth/login', {
    data: { username: 'admin', password: ADMIN_PASSWORD },
  });
  expect(login.status()).toBe(204);
  if (ctx === null) {
    const portalA = await ensurePortal(page.request, NAME_A, PORTAL_A_URL, '00:1A:79:00:CA:01');
    const portalB = await ensurePortal(page.request, NAME_B, PORTAL_B_URL, '00:1A:79:00:CA:02');
    const list = (await (await page.request.get(`/api/portals/${portalA}/channels`)).json()) as {
      channels: { id: string; epgId: string | null; censored: boolean }[];
    };
    const usable = list.channels.filter((c) => !c.censored);
    ctx = {
      portalA,
      portalB,
      bSide: new Set([portalB]),
      paired: usable.filter((c) => Number(c.id) <= SHARED_CHANNELS && c.epgId !== null).map((c) => c.id),
      alone: usable.filter((c) => Number(c.id) > SHARED_CHANNELS).map((c) => c.id),
    };
    // Le catalogue de B doit être connu du serveur pour qu'il y trouve des sources.
    await page.request.get(`/api/portals/${portalB}/channels`);
  }
  const hostB = new URL(PORTAL_B_URL).host;
  const portals = (await (await page.request.get('/api/portals')).json()) as { id: string; host: string }[];
  ctx.bSide = new Set(portals.filter((p) => p.host === hostB).map((p) => p.id));
  await page.goto('/');
  await page.evaluate((id) => {
    localStorage.setItem('lumen.portal', id);
  }, ctx.portalA);
  await resetChaos();
  return ctx;
}

/** Chaîne de test : une différente par scénario, pour ne pas hériter du relais du précédent. */
const pick = (list: readonly string[], index: number): string => {
  const id = list[index];
  if (id === undefined) throw new Error(`pas assez de chaînes de test (${index})`);
  return id;
};

interface Observation {
  maxStallMs: number;
  spinnerSeen: boolean;
  errorSeen: boolean;
  advancedS: number;
  observedS: number;
  sources: string[];
}

declare global {
  interface Window {
    lumenChaos?: {
      samples: { at: number; t: number; paused: boolean; buf: string }[];
      spinner: boolean;
      error: boolean;
      sources: string[];
    };
  }
}

/** Ouvre la chaîne dans le lecteur de l'application et attend que l'image avance. */
async function watch(page: Page, portalId: string, channelId: string): Promise<string> {
  await page.goto(`/regarder/${portalId}/${channelId}`);
  await page.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) > 1, undefined, {
    timeout: 60_000,
  });
  const sessionId = await page.getAttribute('[data-testid=player]', 'data-session');
  if (sessionId === null) throw new Error('session de lecture inconnue');
  return sessionId;
}

/** Démarre l'enregistrement de ce que voit le spectateur (10 mesures par seconde). */
async function record(page: Page): Promise<void> {
  await page.evaluate(() => {
    const video = document.querySelector('video');
    if (video === null) throw new Error('pas de lecteur');
    const rec = {
      samples: [] as { at: number; t: number; paused: boolean; buf: string }[],
      spinner: false,
      error: false,
      sources: [] as string[],
    };
    window.lumenChaos = rec;
    setInterval(() => {
      // Plages du tampon : distinguer un trou (DISCONTINUITY) d'un manque de données.
      const ranges: string[] = [];
      for (let i = 0; i < video.buffered.length; i++) {
        ranges.push(`${video.buffered.start(i).toFixed(2)}-${video.buffered.end(i).toFixed(2)}`);
      }
      rec.samples.push({
        at: performance.now(),
        t: video.currentTime,
        paused: video.paused,
        buf: ranges.join(' '),
      });
      if (document.querySelector('.spinner') !== null) rec.spinner = true;
      if (document.querySelector('.player-message[role=alert]') !== null) rec.error = true;
      const source = document.querySelector('[data-testid=source-indicator]')?.textContent ?? '';
      if (source !== '' && rec.sources.at(-1) !== source) rec.sources.push(source);
    }, 100);
  });
}

async function observe(page: Page, durationMs: number): Promise<Observation> {
  await page.waitForTimeout(durationMs);
  const rec = await page.evaluate(() => window.lumenChaos);
  if (rec === undefined) throw new Error('enregistrement absent');
  let maxStallMs = 0;
  let stallBuffer = '';
  let since: number | null = null;
  for (let i = 1; i < rec.samples.length; i++) {
    const prev = rec.samples[i - 1]!;
    const cur = rec.samples[i]!;
    if (!cur.paused && cur.t <= prev.t) {
      since ??= prev.at;
      if (cur.at - since > maxStallMs) {
        maxStallMs = cur.at - since;
        stallBuffer = `t=${cur.t.toFixed(2)} [${cur.buf}]`;
      }
    } else {
      since = null;
    }
  }
  const first = rec.samples[0];
  const last = rec.samples.at(-1);
  const result: Observation = {
    maxStallMs: Math.round(maxStallMs),
    spinnerSeen: rec.spinner,
    errorSeen: rec.error,
    advancedS: Number(((last?.t ?? 0) - (first?.t ?? 0)).toFixed(1)),
    observedS: Number((((last?.at ?? 0) - (first?.at ?? 0)) / 1000).toFixed(1)),
    sources: rec.sources,
  };
  console.log(
    `[${test.info().title}]`,
    JSON.stringify(result),
    maxStallMs > 0 ? `arrêt à ${stallBuffer}` : '',
  );
  return result;
}

interface Status {
  state: string;
  activePortalId: string;
}

async function status(page: Page, sessionId: string): Promise<Status> {
  return (await (await page.request.get(`/api/playback/${sessionId}/status`)).json()) as Status;
}

/** Temps écoulé jusqu'à ce que le relais serve en direct depuis l'un des portails `to` (ms), ou null. */
async function timeToSwitch(
  page: Page,
  sessionId: string,
  to: ReadonlySet<string>,
  startedAt: number,
  timeoutMs: number,
): Promise<number | null> {
  while (Date.now() - startedAt < timeoutMs) {
    const s = await status(page, sessionId);
    if (to.has(s.activePortalId) && s.state === 'live') return Date.now() - startedAt;
    await page.waitForTimeout(100);
  }
  return null;
}

test.afterEach(async () => {
  await resetChaos();
});

test('1. coupure amont de 15 s : aucune interruption visible, aucun indicateur de chargement', async ({
  page,
}) => {
  const c = await setup(page);
  const channel = pick(c.alone, 0);
  // Chaîne déjà regardée : le relais a 30 s de flux d'avance, le lecteur s'y place en retard.
  const warm = await page.request.post('/api/playback', {
    data: { portalId: c.portalA, channelId: channel },
  });
  expect(warm.status()).toBe(201);
  await page.waitForTimeout(32_000);
  await watch(page, c.portalA, channel);
  await page.waitForTimeout(5000);
  await record(page);
  await chaos(PORTAL_A_URL, 'drop', { durationMs: 15_000, channelId: channel });
  const o = await observe(page, 30_000);
  expect(o.maxStallMs).toBeLessThan(INVISIBLE_STALL_MS);
  expect(o.spinnerSeen).toBe(false);
  expect(o.errorSeen).toBe(false);
});

test('2. coupure amont de 90 s : reprise automatique, aucune erreur si une source alternative existe', async ({
  page,
}) => {
  const c = await setup(page);
  const channel = pick(c.paired, 0);
  const session = await watch(page, c.portalA, channel);
  await record(page);
  const t0 = Date.now();
  await chaos(PORTAL_A_URL, 'drop', { durationMs: 90_000, channelId: channel });
  const switchMs = await timeToSwitch(page, session, c.bSide, t0, 30_000);
  const o = await observe(page, 20_000);
  expect(switchMs).not.toBeNull();
  expect(o.errorSeen).toBe(false);
  expect(o.maxStallMs).toBeLessThan(INVISIBLE_STALL_MS);
  // L'indicateur nomme le portail de secours qui sert l'image.
  expect(o.sources.at(-1)).toMatch(/secours : /);
});

test('3. token expiré en pleine lecture : renouvellement transparent, lecture continue', async ({ page }) => {
  const c = await setup(page);
  await watch(page, c.portalA, pick(c.alone, 1));
  await record(page);
  await chaos(PORTAL_A_URL, 'expire-token', { killStreams: true });
  const o = await observe(page, 20_000);
  expect(o.maxStallMs).toBeLessThan(INVISIBLE_STALL_MS);
  expect(o.spinnerSeen).toBe(false);
  expect(o.errorSeen).toBe(false);
  expect(o.advancedS).toBeGreaterThan(o.observedS * 0.9);
});

test('4. HTTP 403 soudain : nouveau create_link puis bascule en moins de 2 s', async ({ page }) => {
  const c = await setup(page);
  const channel = pick(c.paired, 1);
  const session = await watch(page, c.portalA, channel);
  await record(page);
  await chaos(PORTAL_A_URL, 'http-error', { code: 403, probability: 1, scope: 'stream' });
  const t0 = Date.now();
  // Coupe le flux en cours : la reconnexion tombe sur le 403.
  await chaos(PORTAL_A_URL, 'drop', { durationMs: 1, channelId: channel });
  const switchMs = await timeToSwitch(page, session, c.bSide, t0, 15_000);
  console.log(`403 → bascule : ${String(switchMs)} ms`);
  const o = await observe(page, 10_000);
  expect(switchMs).not.toBeNull();
  expect(switchMs ?? Infinity).toBeLessThan(MAX_SWITCH_MS);
  expect(o.maxStallMs).toBeLessThan(INVISIBLE_STALL_MS);
});

test('5. gel PTS de 8 s : détecté en moins de 2,5 s, bascule effectuée', async ({ page }) => {
  const c = await setup(page);
  const channel = pick(c.paired, 2);
  const session = await watch(page, c.portalA, channel);
  await record(page);
  const t0 = Date.now();
  await chaos(PORTAL_A_URL, 'freeze', { durationMs: 8000, channelId: channel });
  const switchMs = await timeToSwitch(page, session, c.bSide, t0, 15_000);
  console.log(`gel → bascule : ${String(switchMs)} ms`);
  const o = await observe(page, 12_000);
  expect(switchMs).not.toBeNull();
  // Détection (2,5 s) puis bascule (2 s).
  expect(switchMs ?? Infinity).toBeLessThan(MAX_FREEZE_DETECTION_MS + MAX_SWITCH_MS);
  expect(o.maxStallMs).toBeLessThan(INVISIBLE_STALL_MS);
});

test('6. écran noir de 15 s : détecté, source déclassée, bascule', async ({ page }) => {
  const c = await setup(page);
  const channel = pick(c.paired, 3);
  const session = await watch(page, c.portalA, channel);
  await record(page);
  const t0 = Date.now();
  await chaos(PORTAL_A_URL, 'blackscreen', { durationMs: 15_000, channelId: channel });
  const switchMs = await timeToSwitch(page, session, c.bSide, t0, 20_000);
  console.log(`écran noir → bascule : ${String(switchMs)} ms`);
  await observe(page, 5000);
  expect(switchMs).not.toBeNull();
  // Source déclassée : son score est désormais inférieur à celui de B.
  const health = (await (
    await page.request.get(`/api/portals/${c.portalA}/channels/${channel}/health`)
  ).json()) as {
    sources: { portalId: string; score: number }[];
  };
  const scoreA = health.sources.find((s) => s.portalId === c.portalA)?.score ?? Infinity;
  const scoreB = Math.max(...health.sources.filter((s) => c.bSide.has(s.portalId)).map((s) => s.score));
  expect(scoreA).toBeLessThan(scoreB);
});

test('7. débit divisé par 5 : descente de qualité ou de source, pas de rebuffering', async ({ page }) => {
  const c = await setup(page);
  const channel = pick(c.paired, 4);
  const session = await watch(page, c.portalA, channel);
  await page.waitForTimeout(4000);
  await record(page);
  // Débit nominal ≈ 1,3 Mbit/s (vidéo 1 200 + audio 96) : divisé par 5.
  await chaos(PORTAL_A_URL, 'throttle', { bitrateKbps: 260 });
  const o = await observe(page, 40_000);
  expect(c.bSide.has((await status(page, session)).activePortalId)).toBe(true);
  expect(o.maxStallMs).toBeLessThan(INVISIBLE_STALL_MS);
  expect(o.spinnerSeen).toBe(false);
});

test('8. source A morte, B saine : bascule en moins de 2 s, aucune coupure audio', async ({ page }) => {
  const c = await setup(page);
  const channel = pick(c.paired, 5);
  const session = await watch(page, c.portalA, channel);
  await record(page);
  const t0 = Date.now();
  await chaos(PORTAL_A_URL, 'drop', { durationMs: 120_000, channelId: channel });
  const switchMs = await timeToSwitch(page, session, c.bSide, t0, 15_000);
  console.log(`A morte → bascule : ${String(switchMs)} ms`);
  const o = await observe(page, 15_000);
  expect(switchMs).not.toBeNull();
  expect(switchMs ?? Infinity).toBeLessThan(MAX_SWITCH_MS);
  // L'audio suit l'horloge de lecture : aucune avance perdue, aucun arrêt.
  expect(o.maxStallMs).toBeLessThan(INVISIBLE_STALL_MS);
  expect(o.advancedS).toBeGreaterThan(o.observedS * 0.9);
});

test('9. portail injoignable au démarrage : catalogue local, message clair', async ({ page }) => {
  await setup(page);
  await page.goto('/tv');
  await expect(page.getByTestId('channel-row').first()).toBeVisible({ timeout: 60_000 });
  // Le portail ne répond plus à aucune requête d'API : redémarrage de l'application.
  await chaos(PORTAL_A_URL, 'http-error', { code: 503, probability: 1, scope: 'all' });
  await page.reload();
  await expect(page.getByTestId('channel-row').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('status').filter({ hasText: /injoignable/i })).toBeVisible({ timeout: 15_000 });
});

test('10. 50 spectateurs sur une chaîne : une seule connexion amont, charge CPU stable', async ({ page }) => {
  const c = await setup(page);
  const channel = pick(c.alone, 2);
  const viewers = 50;
  const sessions: string[] = [];
  for (let i = 0; i < viewers; i++) {
    const res = await page.request.post('/api/playback', {
      data: { portalId: c.portalA, channelId: channel },
    });
    expect(res.status(), await res.text()).toBe(201);
    sessions.push(((await res.json()) as { sessionId: string }).sessionId);
  }
  const cpu = async (): Promise<number> => {
    const text = await (
      await page.request.get('/metrics', { headers: { Authorization: `Bearer ${METRICS_TOKEN}` } })
    ).text();
    const value = /^process_cpu_seconds_total (\S+)$/m.exec(text)?.[1];
    if (value === undefined) throw new Error('process_cpu_seconds_total absent de /metrics');
    return Number(value);
  };
  // Chaque spectateur se comporte comme hls.js : playlist toutes les 2 s, nouveaux segments.
  let running = true;
  const seen = new Map<string, Set<string>>();
  const viewer = async (sid: string): Promise<void> => {
    const got = new Set<string>();
    seen.set(sid, got);
    while (running) {
      const playlist = await (await page.request.get(`/api/playback/${sid}/index.m3u8`)).text();
      for (const line of playlist
        .split('\n')
        .filter((l) => l.startsWith('seg/'))
        .slice(-2)) {
        if (got.has(line)) continue;
        got.add(line);
        await page.request.get(`/api/playback/${sid}/${line}`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  };
  const loops = sessions.map((sid) => viewer(sid));
  const halfMs = 20_000;
  const c0 = await cpu();
  await page.waitForTimeout(halfMs);
  const c1 = await cpu();
  await page.waitForTimeout(halfMs);
  const c2 = await cpu();
  running = false;
  await Promise.all(loops);
  const first = (c1 - c0) / (halfMs / 1000);
  const second = (c2 - c1) / (halfMs / 1000);
  console.log(`CPU serveur (cœur) : ${first.toFixed(3)} puis ${second.toFixed(3)}`);
  const state = (await (await fetch(`${PORTAL_A_URL}/_chaos/state`)).json()) as {
    activeStreams: Record<string, number>;
  };
  expect(state.activeStreams[channel] ?? 0).toBe(1);
  // Stable : pas de dérive entre les deux moitiés, et loin de saturer un cœur.
  expect(second).toBeLessThan(first * 1.5 + 0.05);
  expect(second).toBeLessThan(0.5);
  expect([...seen.values()].every((s) => s.size > 0)).toBe(true);
  for (const sid of sessions) await page.request.delete(`/api/playback/${sid}`);
});
