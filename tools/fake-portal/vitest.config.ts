import { defineProject } from 'vitest/config';

// Les tests de chaos observent un flux cadencé en temps réel : quelques secondes chacun.
const CHAOS_TEST_TIMEOUT_MS = 30_000;
// Génération des mires FFmpeg au premier lancement (ensuite en cache).
const ASSET_GENERATION_TIMEOUT_MS = 180_000;

export default defineProject({
  test: {
    name: 'fake-portal',
    include: ['test/**/*.test.ts'],
    // Les tests qui mesurent des délais réels tournent à part (vitest.realtime.config.ts).
    exclude: ['test/**/*.realtime.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: CHAOS_TEST_TIMEOUT_MS,
    hookTimeout: ASSET_GENERATION_TIMEOUT_MS,
  },
});
