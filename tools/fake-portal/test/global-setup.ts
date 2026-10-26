import { configFromEnv } from '../src/config.js';
import { loadMediaAssets } from '../src/media/assets.js';

/** Génère les mires une seule fois avant que les fichiers de test ne les chargent en parallèle. */
export default async function setup(): Promise<void> {
  const config = configFromEnv(process.env);
  await loadMediaAssets(config.media, config.assetDir, config.ffmpegPath);
}
