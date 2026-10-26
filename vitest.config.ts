import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Seuls les paquets qui déclarent leur propre configuration Vitest sont des projets de test.
    projects: ['{packages,apps,tools}/*/vitest.config.ts'],
  },
});
