import { configFromEnv, type FakePortalConfigInput } from './config.js';
import { type MediaAssets, loadMediaAssets } from './media/assets.js';
import { type FakePortal, createFakePortal } from './server.js';

/** Outils pour démarrer le portail factice depuis les tests des autres paquets. */

const envConfig = configFromEnv(process.env);
let assetsPromise: Promise<MediaAssets> | undefined;

/** Mires chargées une fois par processus de test. */
export const sharedAssets = (): Promise<MediaAssets> =>
  (assetsPromise ??= loadMediaAssets(envConfig.media, envConfig.assetDir, envConfig.ffmpegPath));

export interface RunningPortal extends FakePortal {
  baseUrl: string;
  close(): Promise<void>;
}

export async function startPortal(overrides: FakePortalConfigInput = {}): Promise<RunningPortal> {
  const portal = await createFakePortal(
    { host: '127.0.0.1', port: 0, logLevel: 'silent', ...overrides },
    { assets: await sharedAssets() },
  );
  await portal.app.listen({ host: '127.0.0.1', port: 0 });
  const address = portal.app.server.address();
  if (address === null || typeof address === 'string') throw new Error('adresse inattendue');
  return { ...portal, baseUrl: `http://127.0.0.1:${address.port}`, close: () => portal.app.close() };
}

export async function sendChaos(
  baseUrl: string,
  scenario: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${baseUrl}/_chaos/${scenario}`, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`chaos ${scenario} → HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

/** À appeler depuis un globalSetup Vitest : génère les mires avant les tests parallèles. */
export async function ensureAssets(): Promise<void> {
  await sharedAssets();
}
