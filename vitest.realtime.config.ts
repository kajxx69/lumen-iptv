import { defineConfig } from 'vitest/config';

/**
 * Suites qui mesurent des délais réels. Lancées après les autres (`pnpm test`), un fichier
 * à la fois : une mesure de bascule ou de reprise n'a de valeur que sur une machine calme.
 */
export default defineConfig({
  test: {
    projects: ['{apps,tools}/*/vitest.realtime.config.ts'],
    fileParallelism: false,
  },
});
