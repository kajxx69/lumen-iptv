import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';

const FAKE_PORTAL_URL = process.env['E2E_FAKE_PORTAL_URL'] ?? 'http://127.0.0.1:18080';
const FAKE_PORTAL_B_URL = process.env['E2E_FAKE_PORTAL_B_URL'] ?? 'http://127.0.0.1:18081';
const ADMIN_PASSWORD = process.env['E2E_ADMIN_PASSWORD'] ?? '';
const HLS_JS = createRequire(import.meta.url).resolve('hls.js/dist/hls.min.js');

/** La chaîne 1 du portail A est la chaîne 100001 du portail B (graine 2). */
const CHANNEL_A = '1';
const CHANNEL_B = '100001';
/** Lecture observée avant la panne : le lecteur est installé, son tampon rempli. */
const WARMUP_MS = 8000;
/** Observation après la panne : le lecteur, en retard sur le direct, doit traverser la jonction. */
const OBSERVE_MS = 20_000;
/** Au-delà, un spectateur voit l'image se figer. */
const MAX_VISIBLE_STALL_MS = 1000;

interface PlayerReport {
  manifestLoads: number;
  fatalErrors: string[];
  /** Erreurs récupérées par hls.js lui-même (réessai de segment, petit trou sauté). */
  minorErrors: string[];
  maxCc: number;
  /** Fragments joués, `numéro/compteur de discontinuité`. */
  played: string[];
  samples: { at: number; t: number }[];
  waitingEvents: number;
}

declare global {
  interface Window {
    Hls: typeof import('hls.js').default;
    lumenReport: () => PlayerReport;
  }
}

// La page de test injecte hls.js et son harnais en ligne : seul le test lève la CSP.
test.use({ bypassCSP: true });
// Le démarrage à froid de Chromium (création de la page comprise) peut prendre 30 s ici.
test.describe.configure({ timeout: 180_000 });

/**
 * Critère de la phase 3 : pendant une bascule de source amont, le lecteur hls.js d'un vrai
 * navigateur ne se réinitialise pas, ne voit aucune erreur fatale et l'image ne se fige pas.
 */
test('bascule de source pendant la lecture : hls.js continue sans réinitialisation', async ({ page }) => {
  await page.goto('/');
  await page.addScriptTag({ path: HLS_JS });

  const streamUrl = await page.evaluate(
    async ({ portalA, portalB, password, channelA, channelB }) => {
      const json = { 'Content-Type': 'application/json' };
      await fetch('/api/auth/login', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ username: 'admin', password }),
      });
      const portals = (await (await fetch('/api/portals')).json()) as { id: string; name: string }[];
      const ensure = async (name: string, url: string, mac: string): Promise<string> => {
        const found = portals.find((p) => p.name === name);
        if (found !== undefined) return found.id;
        const res = await fetch('/api/portals', {
          method: 'POST',
          headers: json,
          body: JSON.stringify({ name, url: `${url}/stalker_portal/c/`, mac }),
        });
        return ((await res.json()) as { id: string }).id;
      };
      const a = await ensure('Relais A', portalA, '00:1A:79:00:E2:E1');
      const b = await ensure('Relais B', portalB, '00:1A:79:00:E2:E2');
      const res = await fetch('/api/playback', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({
          portalId: a,
          channelId: channelA,
          fallbacks: [{ portalId: b, channelId: channelB }],
        }),
      });
      if (res.status !== 201) throw new Error(`lecture refusée : ${res.status} ${await res.text()}`);
      return ((await res.json()) as { streamUrl: string }).streamUrl;
    },
    {
      portalA: FAKE_PORTAL_URL,
      portalB: FAKE_PORTAL_B_URL,
      password: ADMIN_PASSWORD,
      channelA: CHANNEL_A,
      channelB: CHANNEL_B,
    },
  );

  const supported = await page.evaluate(() => window.Hls.isSupported());
  expect(supported, 'MSE + H.264/AAC indisponibles dans ce navigateur').toBe(true);

  await page.evaluate((url) => {
    const video = document.createElement('video');
    video.muted = true;
    video.autoplay = true;
    document.body.append(video);
    const report: PlayerReport = {
      manifestLoads: 0,
      fatalErrors: [],
      minorErrors: [],
      maxCc: 0,
      played: [],
      samples: [],
      waitingEvents: 0,
    };
    const hls = new window.Hls({ liveSyncDurationCount: 3 });
    hls.on(window.Hls.Events.MANIFEST_LOADING, () => report.manifestLoads++);
    hls.on(window.Hls.Events.ERROR, (_e, data) => {
      if (data.fatal) report.fatalErrors.push(`${data.type}/${data.details}`);
      else report.minorErrors.push(data.details);
    });
    hls.on(window.Hls.Events.FRAG_CHANGED, (_e, data) => {
      report.maxCc = Math.max(report.maxCc, data.frag.cc);
      report.played.push(`${String(data.frag.sn)}/${data.frag.cc}`);
    });
    video.addEventListener('waiting', () => report.waitingEvents++);
    setInterval(() => report.samples.push({ at: performance.now(), t: video.currentTime }), 100);
    hls.attachMedia(video);
    hls.loadSource(url);
    window.lumenReport = () => report;
  }, streamUrl);

  const started = await page
    .waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) > 1, undefined, {
      timeout: 60_000,
    })
    .then(() => true)
    .catch(() => false);
  if (!started)
    console.log('lecture non démarrée :', JSON.stringify(await page.evaluate(() => window.lumenReport())));
  expect(started).toBe(true);
  await page.waitForTimeout(WARMUP_MS);

  const cut = await fetch(`${FAKE_PORTAL_URL}/_chaos/drop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ durationMs: 120_000, channelId: CHANNEL_A }),
  });
  expect(cut.ok).toBe(true);
  const cutAt = await page.evaluate(() => performance.now());
  await page.waitForTimeout(OBSERVE_MS);

  const report = await page.evaluate(() => window.lumenReport());
  const after = report.samples.filter((s) => s.at >= cutAt);
  let maxStallMs = 0;
  let stallStart: number | null = null;
  let regressions = 0;
  for (let i = 1; i < after.length; i++) {
    const prev = after[i - 1]!;
    const cur = after[i]!;
    if (cur.t < prev.t) regressions++;
    if (cur.t <= prev.t) {
      stallStart ??= prev.at;
      maxStallMs = Math.max(maxStallMs, cur.at - stallStart);
    } else {
      stallStart = null;
    }
  }
  const advanced = (after.at(-1)?.t ?? 0) - (after[0]?.t ?? 0);
  console.log(
    'bascule vue par hls.js :',
    JSON.stringify({
      manifestLoads: report.manifestLoads,
      fatalErrors: report.fatalErrors,
      minorErrors: report.minorErrors,
      maxCc: report.maxCc,
      played: report.played,
      waitingEvents: report.waitingEvents,
      maxStallMs: Math.round(maxStallMs),
      advancedS: Number(advanced.toFixed(2)),
      observedS: OBSERVE_MS / 1000,
    }),
  );

  // Jonction traversée : le lecteur a joué des fragments du compteur de discontinuité suivant.
  expect(report.maxCc).toBeGreaterThanOrEqual(1);
  // Jamais rechargé : une seule playlist chargée, aucune erreur fatale.
  expect(report.manifestLoads).toBe(1);
  expect(report.fatalErrors).toEqual([]);
  // La position ne recule jamais et l'image ne se fige pas de façon visible.
  expect(regressions).toBe(0);
  expect(maxStallMs).toBeLessThan(MAX_VISIBLE_STALL_MS);
  expect(advanced).toBeGreaterThan((OBSERVE_MS / 1000) * 0.9);
});
