import { defineProject } from 'vitest/config';

// Les tests d'intégration parlent au portail factice à 5 requêtes/s, comme en production.
const INTEGRATION_TEST_TIMEOUT_MS = 60_000;
// Génération des mires FFmpeg au premier lancement (ensuite en cache).
const ASSET_GENERATION_TIMEOUT_MS = 180_000;

export default defineProject({
  test: {
    name: 'core',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: INTEGRATION_TEST_TIMEOUT_MS,
    hookTimeout: ASSET_GENERATION_TIMEOUT_MS,
  },
});
