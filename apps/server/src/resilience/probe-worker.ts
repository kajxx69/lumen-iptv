import type { FastifyBaseLogger } from 'fastify';
import type { CatalogService } from '../catalog/catalog-service.js';
import type { PortalRegistry } from '../portals/registry.js';
import type { HealthService, SourceRef } from './health-service.js';
import type { ProbeScheduler } from './probe-scheduler.js';

/** Le planificateur est consulté chaque seconde ; une seule sonde à la fois. */
const PROBE_TICK_MS = 1000;
/** Une sonde n'attend pas un flux plus longtemps : au-delà, la source est notée en échec. */
const PROBE_TIMEOUT_MS = 8000;

export interface ProbeDeps {
  registry: PortalRegistry;
  catalog: CatalogService;
  health: HealthService;
  log: FastifyBaseLogger;
}

/**
 * Sonde une source comme le ferait un spectateur pressé : lien (create_link), premier
 * octet du flux, puis fermeture immédiate. Les mesures alimentent le score de santé.
 */
export async function probeSource(ref: SourceRef, deps: ProbeDeps): Promise<void> {
  const channel = await deps.catalog.channel(ref.portalId, ref.channelId);
  if (channel === null) return;
  const portal = deps.registry.get(ref.portalId);
  const resolveStart = Date.now();
  let url: string;
  try {
    url = (await portal.provider.client.createLink(channel.cmd)).url;
    deps.health.record(ref, { kind: 'resolve', at: Date.now(), ms: Date.now() - resolveStart, ok: true });
  } catch {
    deps.health.record(ref, { kind: 'resolve', at: Date.now(), ms: Date.now() - resolveStart, ok: false });
    deps.health.record(ref, { kind: 'down', at: Date.now() });
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, PROBE_TIMEOUT_MS);
  const fetchStart = Date.now();
  try {
    const res = await fetch(url, { headers: { 'User-Agent': portal.userAgent }, signal: controller.signal });
    const first = res.ok && res.body !== null ? await res.body.getReader().read() : null;
    if (first === null || first.done) throw new Error('flux vide');
    const now = Date.now();
    deps.health.record(ref, { kind: 'firstByte', at: now, ms: now - fetchStart });
    deps.health.record(ref, { kind: 'segment', at: now, ok: true });
    deps.health.record(ref, { kind: 'up', at: now });
  } catch {
    deps.health.record(ref, { kind: 'segment', at: Date.now(), ok: false });
    deps.health.record(ref, { kind: 'down', at: Date.now() });
  } finally {
    clearTimeout(timer);
    // Connexion libérée aussitôt : la sonde ne doit pas occuper la MAC du portail.
    controller.abort();
  }
}

/** Exécute les sondes choisies par le planificateur, une à la fois, en arrière-plan. */
export class ProbeWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly scheduler: ProbeScheduler,
    private readonly deps: ProbeDeps,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      this.tick();
    }, PROBE_TICK_MS);
    this.timer.unref();
  }

  private tick(): void {
    if (this.running) return;
    const ref = this.scheduler.next(Date.now());
    if (ref === null) return;
    this.running = true;
    probeSource(ref, this.deps)
      .catch((err: unknown) => {
        // Portail supprimé ou catalogue absent : la sonde suivante continue.
        this.deps.log.debug({ err: err instanceof Error ? err.name : 'inconnue' }, 'sonde impossible');
      })
      .finally(() => {
        this.scheduler.done(ref, Date.now());
        this.running = false;
      });
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }
}
