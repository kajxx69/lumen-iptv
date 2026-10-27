import { ErrorDto } from '@lumen/protocol';
import type { z } from 'zod';

/** Erreur d'API lisible : code stable pour le programme, message en français pour l'écran. */
export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Le réseau lui-même est tombé (hors ligne, serveur injoignable) : rien n'a été répondu. */
export class OfflineError extends Error {
  override readonly name = 'OfflineError';
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();

/** Prévenu quand une requête revient en 401 : la session a expiré, retour à la connexion. */
export function onUnauthorized(listener: Listener): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Requête qui doit partir même si la page se ferme (arrêt de lecture). */
  keepalive?: boolean;
}

export async function request(path: string, options: RequestOptions = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.keepalive === true ? { keepalive: true } : {}),
      credentials: 'same-origin',
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new OfflineError('serveur injoignable');
  }
  if (res.ok || res.status === 304) return res;
  if (res.status === 401) for (const l of unauthorizedListeners) l();
  const parsed = ErrorDto.safeParse(await res.json().catch(() => null));
  throw parsed.success
    ? new ApiError(res.status, parsed.data.error.code, parsed.data.error.message)
    : new ApiError(res.status, 'internal', `erreur ${res.status}`);
}

/** Requête JSON validée par le schéma du contrat : une réponse inattendue échoue tôt et clairement. */
export async function requestJson<S extends z.ZodType>(
  schema: S,
  path: string,
  options: RequestOptions = {},
): Promise<z.output<S>> {
  const res = await request(path, options);
  return schema.parse(await res.json());
}
