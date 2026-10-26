import { DEVICE_PROFILES, type Runtime, StalkerProvider } from '@lumen/core/stalker';
import type { FastifyBaseLogger } from 'fastify';
import { notFound } from '../http/errors.js';
import type { PortalRecord, PortalSecret, PortalStore } from '../store/portal-store.js';

/** Adaptateurs Node du `Runtime` exigé par le cœur. */
export function nodeRuntime(log: FastifyBaseLogger): Runtime {
  return {
    http: {
      async request(req) {
        const res = await fetch(req.url, {
          method: req.method,
          headers: req.headers,
          signal: AbortSignal.timeout(req.timeoutMs),
        });
        const headers: Record<string, string> = {};
        res.headers.forEach((value, name) => {
          headers[name] = value;
        });
        return { status: res.status, headers, body: await res.text() };
      },
    },
    now: () => Date.now(),
    setTimer: (callback, ms) => {
      const handle = setTimeout(callback, ms);
      // Les minuteurs du cœur (maintien de session) ne doivent pas empêcher l'arrêt du serveur.
      handle.unref();
      return () => {
        clearTimeout(handle);
      };
    },
    random: Math.random,
    logger: {
      debug: (ctx, msg) => {
        log.debug(ctx, msg);
      },
      info: (ctx, msg) => {
        log.info(ctx, msg);
      },
      warn: (ctx, msg) => {
        log.warn(ctx, msg);
      },
      error: (ctx, msg) => {
        log.error(ctx, msg);
      },
    },
  };
}

export interface ActivePortal {
  record: PortalRecord;
  provider: StalkerProvider;
  /** User-Agent du profil d'appareil : certains serveurs de flux le vérifient aussi. */
  userAgent: string;
  /** Origine du portail, pour recomposer les logos stockés en chemin seul. */
  origin: string;
}

function providerFor(id: string, secret: PortalSecret, runtime: Runtime): StalkerProvider {
  return new StalkerProvider(
    {
      id,
      portalUrl: secret.url,
      mac: secret.mac,
      device: secret.device,
      ...(secret.login === undefined || secret.password === undefined
        ? {}
        : { credentials: { login: secret.login, password: secret.password } }),
      correlationId: `portal:${id}`,
    },
    runtime,
  );
}

/**
 * Un client Stalker par portail, partagé par tous les utilisateurs : une seule session,
 * un seul limiteur de débit, donc une seule MAC qui ne se fait pas bannir.
 */
export class PortalRegistry {
  private readonly active = new Map<string, ActivePortal>();

  constructor(
    private readonly store: PortalStore,
    private readonly runtime: Runtime,
  ) {}

  get(portalId: string): ActivePortal {
    const cached = this.active.get(portalId);
    if (cached !== undefined) return cached;
    const record = this.store.get(portalId);
    if (record === null) throw notFound('portail');
    const portal: ActivePortal = {
      record,
      provider: providerFor(record.id, record.secret, this.runtime),
      userAgent: DEVICE_PROFILES[record.secret.device].userAgent,
      origin: new URL(record.secret.url).origin,
    };
    this.active.set(portalId, portal);
    return portal;
  }

  /** Ouvre une session d'essai : lève une StalkerError si le portail refuse. */
  async verify(secret: PortalSecret): Promise<void> {
    const provider = providerFor('verification', secret, this.runtime);
    try {
      await provider.authenticate();
    } finally {
      provider.close();
    }
  }

  remove(portalId: string): void {
    this.active.get(portalId)?.provider.close();
    this.active.delete(portalId);
  }

  closeAll(): void {
    for (const portal of this.active.values()) portal.provider.close();
    this.active.clear();
  }
}
