// Pré-génère les mires (utile dans l'image Docker pour un démarrage immédiat).
import { configFromEnv } from '../config.js';
import { loadMediaAssets } from './assets.js';

const config = configFromEnv(process.env);
const assets = await loadMediaAssets(config.media, config.assetDir, config.ffmpegPath);
console.log(
  `Mires prêtes dans ${config.assetDir} : ${assets.mire.segments.length} segments de ${assets.mire.segmentDurationS} s`,
);
