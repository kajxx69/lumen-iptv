import type { StalkerTuning } from './config.js';
import { PaginationError, StalkerError, asStalkerError } from './errors.js';
import type { Page } from './parse.js';
import { type Timers, sleep } from './runtime.js';

export type PageFetcher<T> = (page: number) => Promise<Page<T>>;

type Settled<T> = { ok: true; page: Page<T> } | { ok: false; error: StalkerError };

export interface PaginateOptions {
  startPage?: number;
  tuning: StalkerTuning;
  timers: Timers;
}

/**
 * Parcourt une liste paginée et produit ses éléments dans l'ordre des pages.
 *
 * - au plus `pageConcurrency` pages en vol, et jamais plus loin que la page consommée
 *   + concurrence − 1 : un consommateur lent ne déclenche pas de rafale ;
 * - une page en échec est retentée par tours ; si elle échoue définitivement, les pages
 *   précédentes ont toutes été livrées et l'erreur indique la page de reprise.
 */
export async function* paginate<T>(fetchPage: PageFetcher<T>, options: PaginateOptions): AsyncGenerator<T> {
  const { tuning, timers } = options;
  const startPage = Math.max(1, options.startPage ?? 1);

  async function fetchWithRounds(page: number): Promise<Page<T>> {
    for (let round = 0; ; round++) {
      try {
        return await fetchPage(page);
      } catch (err) {
        const error = asStalkerError(err);
        if (!error.retryable || round >= tuning.pageRetryRounds) throw error;
        await sleep(timers, tuning.pageRetryDelayMs);
      }
    }
  }

  const settle = (page: number): Promise<Settled<T>> =>
    fetchWithRounds(page).then(
      (p): Settled<T> => ({ ok: true, page: p }),
      (err: unknown): Settled<T> => ({ ok: false, error: asStalkerError(err) }),
    );

  const first = await settle(startPage);
  if (!first.ok) throw new PaginationError(startPage, first.error);
  yield* first.page.items;

  const pageSize = first.page.pageSize > 0 ? first.page.pageSize : first.page.items.length;
  if (pageSize === 0 || first.page.items.length === 0) return;
  const lastPage = Math.min(
    first.page.totalItems > 0 ? Math.ceil(first.page.totalItems / pageSize) : Number.POSITIVE_INFINITY,
    startPage + tuning.maxPages - 1,
  );

  // Total inconnu : on avance page par page jusqu'à une page vide.
  if (!Number.isFinite(lastPage)) {
    for (let page = startPage + 1; page < startPage + tuning.maxPages; page++) {
      const result = await settle(page);
      if (!result.ok) throw new PaginationError(page, result.error);
      if (result.page.items.length === 0) return;
      yield* result.page.items;
    }
    return;
  }

  const inFlight = new Map<number, Promise<Settled<T>>>();
  let nextToStart = startPage + 1;
  for (let page = startPage + 1; page <= lastPage; page++) {
    while (nextToStart <= lastPage && nextToStart < page + tuning.pageConcurrency) {
      inFlight.set(nextToStart, settle(nextToStart));
      nextToStart++;
    }
    const pending = inFlight.get(page);
    if (pending === undefined) throw new StalkerError('invalid_response', `page ${page} non planifiée`);
    const result = await pending;
    inFlight.delete(page);
    if (!result.ok) throw new PaginationError(page, result.error);
    yield* result.page.items;
  }
}

/** Charge toutes les pages en mémoire : pour les listes courtes (saisons, épisodes, une journée d'EPG). */
export async function collectPages<T>(fetchPage: PageFetcher<T>, options: PaginateOptions): Promise<T[]> {
  const out: T[] = [];
  for await (const item of paginate(fetchPage, options)) out.push(item);
  return out;
}
