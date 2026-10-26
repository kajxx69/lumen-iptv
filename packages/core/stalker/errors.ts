export type StalkerErrorKind =
  /** Échec réseau : socket fermée, hôte injoignable. */
  | 'network'
  | 'timeout'
  /** Statut HTTP inattendu (5xx, 4xx non couverts ci-dessous). */
  | 'http'
  /** 401 : token absent, expiré ou refusé. Le client renouvelle la session. */
  | 'unauthorized'
  /** 403 sur un appel authentifié : token rejeté ou refus passager. Le client renouvelle. */
  | 'forbidden'
  /** Le portail refuse l'appareil (MAC, modèle, en-têtes) de façon persistante. */
  | 'device_rejected'
  /** Le compte exige do_auth et aucun identifiant n'est configuré. */
  | 'auth_required'
  | 'auth_failed'
  /** Compte bloqué ou désactivé selon get_profile. */
  | 'account_inactive'
  /** 429 : la MAC est bannie ; relancer prolongerait le bannissement. */
  | 'rate_limited'
  | 'invalid_response'
  | 'invalid_config'
  | 'endpoint_not_found'
  | 'nothing_to_play'
  | 'pagination_failed';

const RETRYABLE: ReadonlySet<StalkerErrorKind> = new Set(['network', 'timeout', 'unauthorized', 'forbidden']);

/**
 * Erreur unique du client Stalker, discriminée par `kind`. Les messages et `details` ne
 * contiennent jamais de MAC, de token, d'identifiant ni d'URL avec sa requête.
 */
export class StalkerError extends Error {
  readonly kind: StalkerErrorKind;
  readonly status: number | null;
  readonly details: Record<string, unknown>;

  constructor(
    kind: StalkerErrorKind,
    message: string,
    options: { status?: number; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'StalkerError';
    this.kind = kind;
    this.status = options.status ?? null;
    this.details = options.details ?? {};
  }

  /** Vrai si une nouvelle tentative a une chance de réussir. */
  get retryable(): boolean {
    if (this.kind === 'http') return this.status === null || this.status === 408 || this.status >= 500;
    return RETRYABLE.has(this.kind);
  }
}

/** Listing interrompu : `resumeFromPage` permet de reprendre sans doublon ni perte. */
export class PaginationError extends StalkerError {
  readonly resumeFromPage: number;

  constructor(resumeFromPage: number, cause: StalkerError) {
    super('pagination_failed', `listing interrompu à la page ${resumeFromPage} (${cause.kind})`, {
      details: { resumeFromPage, causeKind: cause.kind },
      cause,
    });
    this.name = 'PaginationError';
    this.resumeFromPage = resumeFromPage;
  }

  override get retryable(): boolean {
    return (this.cause as StalkerError).retryable;
  }
}

/**
 * Les échecs réseau sont déjà typés par le transport : toute autre erreur vient d'une
 * réponse que le parseur n'a pas su lire. La relancer ne servirait à rien.
 */
export function asStalkerError(err: unknown): StalkerError {
  if (err instanceof StalkerError) return err;
  return new StalkerError('invalid_response', 'réponse du portail inexploitable', { cause: err });
}
