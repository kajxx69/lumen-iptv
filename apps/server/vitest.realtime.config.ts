import { defineProject } from 'vitest/config';

// Un relais cadencé en temps réel, des pannes de plusieurs secondes : jusqu'à une minute.
const REALTIME_TEST_TIMEOUT_MS = 90_000;
const ASSET_GENERATION_TIMEOUT_MS = 180_000;

/**
 * Tests qui mesurent des délais réels (bascule < 2 s, reprise après coupure). Ils tournent
 * un fichier à la fois (vitest.realtime.config.ts à la racine) : la mesure doit porter sur
 * le relais, pas sur la contention CPU de la machine de test.
 */
export default defineProject({
  test: {
    name: 'server-realtime',
    include: ['test/**/*.realtime.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: REALTIME_TEST_TIMEOUT_MS,
    hookTimeout: ASSET_GENERATION_TIMEOUT_MS,
  },
});
