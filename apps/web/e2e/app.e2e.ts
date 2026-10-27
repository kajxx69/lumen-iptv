import { type Page, expect, test } from '@playwright/test';

const FAKE_PORTAL_URL = process.env['E2E_FAKE_PORTAL_URL'] ?? 'http://127.0.0.1:18080';
const ADMIN_PASSWORD = process.env['E2E_ADMIN_PASSWORD'] ?? '';
const PORTAL_NAME = 'Portail interface';
/** Lignes de liste présentes dans le DOM au plus : la liste est virtualisée, jamais rendue en entier. */
const MAX_RENDERED_ROWS = 80;
/** Ouverture du catalogue depuis le cache local (PROJECT.md : < 1 s, 100 000 entrées). */
const CACHED_OPEN_MAX_MS = 1000;

// Démarrage à froid de Chromium sur une machine modeste, puis lecture réelle d'un flux.
test.describe.configure({ mode: 'serial', timeout: 180_000 });

async function login(page: Page): Promise<void> {
  await page.goto('/');
  const user = page.getByLabel('Identifiant');
  const home = page.getByRole('button', { name: 'TV en direct' });
  await expect(user.or(home)).toBeVisible({ timeout: 30_000 });
  if (await user.isVisible()) {
    await user.fill('admin');
    await page.getByLabel('Mot de passe').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Se connecter' }).click();
  }
  await expect(page.getByRole('button', { name: 'TV en direct' })).toBeVisible();
}

/** Ajoute le portail factice par le formulaire (une seule fois) et l'affiche. */
async function ensurePortal(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Réglages' }).click();
  const card = page.locator('.card', { hasText: PORTAL_NAME });
  if ((await card.count()) === 0) {
    await page.getByLabel('Nom').fill(PORTAL_NAME);
    await page.getByLabel('Adresse du portail').fill(`${FAKE_PORTAL_URL}/stalker_portal/c/`);
    await page.getByLabel('Adresse MAC').fill('00:1A:79:00:0E:2E');
    await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
    await expect(page).toHaveURL(/\/tv$/, { timeout: 30_000 });
    await page.getByRole('button', { name: 'Réglages' }).click();
  }
  const show = card.getByRole('button', { name: 'Afficher', exact: true });
  if ((await show.count()) > 0) await show.click();
}

test('catalogue virtualisé, recherche, lecture, favoris et guide', async ({ page }) => {
  await test.step('connexion et portail', async () => {
    await login(page);
    await ensurePortal(page);
  });

  await test.step('liste de 5 000 chaînes virtualisée', async () => {
    await page.getByRole('button', { name: 'TV en direct' }).click();
    // 5 000 chaînes, moins celles marquées « adulte », masquées tant que le contrôle parental n'existe pas.
    await expect(page.getByRole('button', { name: /^Toutes/ })).toContainText(/49\d\d/, { timeout: 60_000 });
    const rows = page.getByTestId('channel-row');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeLessThan(MAX_RENDERED_ROWS);
    // Programme en cours chargé pour les lignes visibles.
    await expect(page.locator('.programme-now').first()).toBeVisible({ timeout: 20_000 });
  });

  await test.step('ouverture depuis le cache local', async () => {
    const t0 = Date.now();
    await page.reload();
    await expect(page.getByTestId('channel-row').first()).toBeVisible();
    const ms = Date.now() - t0;
    console.log(`ouverture de la liste après rechargement : ${ms} ms`);
    expect(ms).toBeLessThan(CACHED_OPEN_MAX_MS * 3);
  });

  await test.step('recherche instantanée', async () => {
    const search = page.getByRole('searchbox', { name: 'Rechercher une chaîne' });
    const firstName = (await page.locator('.channel-name').first().textContent()) ?? '';
    await search.fill('aucune-chaine-ne-porte-ce-nom');
    await expect(page.getByText(/Aucune chaîne ne correspond/)).toBeVisible();
    const word = firstName.replace(/^\W*[A-Z]{2,3}\s*[|:]\s*/, '').split(/\s+/)[0] ?? '';
    await search.fill(word);
    await expect(page.locator('.channel-name').first()).toContainText(word);
    await search.fill('');
    // La liste complète revient (la recherche suit la frappe en différé).
    await expect(page.locator('.channel-name').first()).toHaveText(firstName);
  });

  await test.step('favori : ajouté, conservé après rechargement, visible à l accueil', async () => {
    const row = page.getByTestId('channel-row').nth(1);
    const name = (await row.locator('.channel-name').textContent()) ?? '';
    const star = row.getByRole('button', { name: /favoris/ });
    if ((await star.getAttribute('aria-pressed')) !== 'true') await star.click();
    await expect(star).toHaveAttribute('aria-pressed', 'true');
    await page.reload();
    await expect(
      page
        .getByTestId('channel-row')
        .nth(1)
        .getByRole('button', { name: /favoris/ }),
    ).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Accueil' }).click();
    await expect(page.locator('.tile', { hasText: name }).first()).toBeVisible();
  });

  await test.step('lecture d une chaîne au clavier (télécommande)', async () => {
    await page.getByRole('button', { name: 'TV en direct' }).click();
    await page.getByTestId('channel-row').first().getByRole('button').first().focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/regarder\//);
    await page.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) > 2, undefined, {
      timeout: 60_000,
    });
    await expect(page.getByTestId('source-indicator')).toContainText('En direct');
    // Zapping : chaîne suivante sans quitter le lecteur.
    const before = page.url();
    await page.keyboard.press('PageDown');
    await expect(page).not.toHaveURL(before);
    await page.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) > 1, undefined, {
      timeout: 60_000,
    });
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/tv/);
  });

  await test.step('guide des programmes', async () => {
    await page.getByRole('button', { name: 'Guide' }).click();
    await expect(page.locator('.programme.live').first()).toBeVisible({ timeout: 30_000 });
    await page.locator('.programme.live').first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).toHaveURL(/\/guide/);
  });
});

test('hors ligne : l application s ouvre avec le catalogue local', async ({ page, context }) => {
  await login(page);
  await ensurePortal(page);
  await page.getByRole('button', { name: 'TV en direct' }).click();
  await expect(page.getByTestId('channel-row').first()).toBeVisible({ timeout: 60_000 });
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // Une navigation de plus : la page elle-même passe par le service worker et entre en cache.
  await page.reload();
  await expect(page.getByTestId('channel-row').first()).toBeVisible();

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText('Hors ligne')).toBeVisible();
  await expect(page.getByTestId('channel-row').first()).toBeVisible({ timeout: 10_000 });
  await context.setOffline(false);
});
