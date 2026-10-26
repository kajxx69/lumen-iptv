import type { DeviceProfile, StalkerTuning } from './config.js';
import { StalkerError } from './errors.js';
import { redactUrl } from './links.js';
import { unwrapEnvelope } from './parse.js';
import type { RateLimiter } from './rate-limiter.js';
import type { HttpResponse, Runtime } from './runtime.js';

export type QueryValue = string | number | boolean;
export type QueryParams = Record<string, QueryValue>;

export interface DeviceIdentity {
  mac: string;
  device: DeviceProfile;
  language: string;
  timezone: string;
}

export function buildQuery(params: QueryParams): string {
  const parts = Object.entries(params).map(([k, v]) => {
    const value = typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
    return `${encodeURIComponent(k)}=${encodeURIComponent(value)}`;
  });
  // Ajouté par les vrais boîtiers MAG ; certains portails le testent.
  parts.push('JsHttpRequest=1-xml');
  return parts.join('&');
}

/** En-têtes d'un boîtier MAG : un navigateur ne peut pas les envoyer, d'où le backend. */
export function stalkerHeaders(
  identity: DeviceIdentity,
  referer: string,
  token: string | null,
): Record<string, string> {
  return {
    Cookie: `mac=${encodeURIComponent(identity.mac)}; stb_lang=${identity.language}; timezone=${encodeURIComponent(identity.timezone)}`,
    'User-Agent': identity.device.userAgent,
    'X-User-Agent': `Model: ${identity.device.model}; Link: WiFi`,
    Referer: referer,
    Accept: '*/*',
    ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
  };
}

const AUTH_FAILED_TEXT = /authori[sz]ation failed/i;

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** Traduit une réponse HTTP en contenu `js` ou en erreur typée. */
export function interpret(res: HttpResponse, action: string): unknown {
  const parsed = parseJson(res.body);
  const status = res.status;
  if (status === 401) throw new StalkerError('unauthorized', `${action} : 401`, { status });
  if (status === 403) throw new StalkerError('forbidden', `${action} : 403`, { status });
  if (status === 429)
    throw new StalkerError('rate_limited', `${action} : le portail limite ou bannit cette MAC`, { status });
  if (status < 200 || status >= 300) throw new StalkerError('http', `${action} : HTTP ${status}`, { status });
  if (!parsed.ok) throw new StalkerError('invalid_response', `${action} : réponse non JSON`, { status });
  const body = parsed.value;
  // Certains portails répondent 200 avec ce texte au lieu d'un 401.
  if (typeof body === 'object' && body !== null && 'text' in body) {
    const text = body.text;
    const js = unwrapEnvelope(body);
    const empty = js === undefined || js === null || (Array.isArray(js) && js.length === 0);
    if (typeof text === 'string' && AUTH_FAILED_TEXT.test(text) && empty) {
      throw new StalkerError('unauthorized', `${action} : authorization failed`, { status });
    }
  }
  return unwrapEnvelope(body);
}

/** Une tentative de requête, limitée en débit et en durée. Pas de relance ici. */
export class Transport {
  constructor(
    private readonly runtime: Runtime,
    private readonly limiter: RateLimiter,
    private readonly tuning: StalkerTuning,
  ) {}

  /** Contenu `js` de la réponse, ou erreur typée. */
  async send(endpoint: string, params: QueryParams, headers: Record<string, string>): Promise<unknown> {
    return interpret(await this.request(endpoint, params, headers), String(params['action'] ?? ''));
  }

  /** Réponse HTTP brute ; seuls le réseau et le délai lèvent une erreur. */
  async request(
    endpoint: string,
    params: QueryParams,
    headers: Record<string, string>,
  ): Promise<HttpResponse> {
    const action = String(params['action'] ?? '');
    await this.limiter.acquire();
    const url = `${endpoint}?${buildQuery(params)}`;
    return this.withTimeout(
      this.runtime.http.request({ url, method: 'GET', headers, timeoutMs: this.tuning.requestTimeoutMs }),
      action,
      endpoint,
    );
  }

  private withTimeout(
    request: Promise<HttpResponse>,
    action: string,
    endpoint: string,
  ): Promise<HttpResponse> {
    const timeoutMs = this.tuning.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      let settled = false;
      const cancel = this.runtime.setTimer(() => {
        if (settled) return;
        settled = true;
        reject(
          new StalkerError('timeout', `${action} : pas de réponse en ${timeoutMs} ms`, {
            details: { endpoint: redactUrl(endpoint) },
          }),
        );
      }, timeoutMs);
      request.then(
        (res) => {
          if (settled) return;
          settled = true;
          cancel();
          resolve(res);
        },
        (err: unknown) => {
          if (settled) return;
          settled = true;
          cancel();
          const isTimeout =
            err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
          reject(
            new StalkerError(
              isTimeout ? 'timeout' : 'network',
              `${action} : ${isTimeout ? 'délai dépassé' : 'portail injoignable'}`,
              {
                details: { endpoint: redactUrl(endpoint) },
                cause: err,
              },
            ),
          );
        },
      );
    });
  }
}
