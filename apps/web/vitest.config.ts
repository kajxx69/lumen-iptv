import { defineProject } from 'vitest/config';

// Indexation de 100 000 entrées dans le test de performance de la recherche.
const WEB_TEST_TIMEOUT_MS = 60_000;

/** Logique pure du client web (recherche, navigation, guide, lecteur), sans navigateur. */
export default defineProject({
  test: {
    name: 'web',
    include: ['test/**/*.test.ts'],
    testTimeout: WEB_TEST_TIMEOUT_MS,
  },
});
