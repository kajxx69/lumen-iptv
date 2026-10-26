/**
 * Tout ce que le client Stalker demande à la plateforme. Le backend Node, une appli
 * Android ou desktop fournissent chacun leur implémentation : le cœur n'importe rien.
 */

export interface HttpRequest {
  url: string;
  method: 'GET';
  headers: Record<string, string>;
  /** L'adaptateur doit abandonner la requête au-delà ; le client applique aussi ce délai. */
  timeoutMs: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Rejette uniquement en cas d'échec réseau ou de délai ; un statut HTTP n'est pas une erreur. */
export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

export interface Timers {
  now(): number;
  /** Programme un rappel ; renvoie la fonction d'annulation. */
  setTimer(callback: () => void, ms: number): () => void;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  context: Record<string, unknown>;
  message: string;
}

export interface Logger {
  debug(context: Record<string, unknown>, message: string): void;
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

export interface Runtime extends Timers {
  http: HttpClient;
  /** Nombre dans [0, 1) : gigue des relances. */
  random(): number;
  logger?: Logger;
}

export const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export const sleep = (timers: Timers, ms: number): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0) resolve();
    else timers.setTimer(resolve, ms);
  });
