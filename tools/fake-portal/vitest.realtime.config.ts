import { defineProject } from 'vitest/config';

// Écran noir et gel observés en temps réel, puis analysés par FFmpeg.
const CHAOS_TEST_TIMEOUT_MS = 60_000;
const ASSET_GENERATION_TIMEOUT_MS = 180_000;

/**
 * Pannes observées en temps réel. Sous contention CPU, FFmpeg et le cadencement du flux
 * prenaient du retard et ces tests échouaient sans que le portail soit en cause : ils
 * tournent un fichier à la fois (vitest.realtime.config.ts à la racine).
 */
export default defineProject({
  test: {
    name: 'fake-portal-realtime',
    include: ['test/**/*.realtime.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: CHAOS_TEST_TIMEOUT_MS,
    hookTimeout: ASSET_GENERATION_TIMEOUT_MS,
  },
});
