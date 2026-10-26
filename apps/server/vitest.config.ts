import { defineProject } from 'vitest/config';

// Les tests traversent le backend jusqu'au portail factice, à 5 requêtes/s.
const INTEGRATION_TEST_TIMEOUT_MS = 60_000;
// Génération des mires FFmpeg au premier lancement (ensuite en cache).
const ASSET_GENERATION_TIMEOUT_MS = 180_000;

export default defineProject({
  test: {
    name: 'server',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: INTEGRATION_TEST_TIMEOUT_MS,
    hookTimeout: ASSET_GENERATION_TIMEOUT_MS,
  },
});
