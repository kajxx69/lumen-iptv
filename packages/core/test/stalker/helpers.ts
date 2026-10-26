import { request } from 'node:http';
import { type RunningPortal, sendChaos, startPortal } from '@lumen/fake-portal';
import type { FakePortalConfigInput } from '@lumen/fake-portal';
import {
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
  type LogEntry,
  type Logger,
  type Runtime,
  type StalkerClientOptions,
  StalkerClient,
} from '../../stalker/index.js';

export { sendChaos, startPortal, type RunningPortal };

export const TEST_MAC = '00:1A:79:12:34:56';

/** Client HTTP Node minimal, tel que l'adaptera le backend (phase 2). */
export const fetchHttp: HttpClient = {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      signal: AbortSignal.timeout(req.timeoutMs),
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    return { status: res.status, headers, body: await res.text() };
  },
};

/** Enregistre chaque requête : permet de compter les appels et la concurrence réelle. */
export class RecordingHttp implements HttpClient {
  readonly requests: { url: string; action: string; status: number | null }[] = [];
  inFlight = 0;
  maxInFlight = 0;

  constructor(private readonly inner: HttpClient = fetchHttp) {}

  async request(req: HttpRequest): Promise<HttpResponse> {
    const action = /[?&]action=([^&]+)/.exec(req.url)?.[1] ?? '';
    const entry = { url: req.url, action, status: null as number | null };
    this.requests.push(entry);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      const res = await this.inner.request(req);
      entry.status = res.status;
      return res;
    } finally {
      this.inFlight--;
    }
  }

  count(action: string): number {
    return this.requests.filter((r) => r.action === action).length;
  }

  reset(): void {
    this.requests.length = 0;
    this.maxInFlight = 0;
  }
}

export class MemoryLogger implements Logger {
  readonly entries: LogEntry[] = [];
  debug(context: Record<string, unknown>, message: string): void {
    this.entries.push({ level: 'debug', context, message });
  }
  info(context: Record<string, unknown>, message: string): void {
    this.entries.push({ level: 'info', context, message });
  }
  warn(context: Record<string, unknown>, message: string): void {
    this.entries.push({ level: 'warn', context, message });
  }
  error(context: Record<string, unknown>, message: string): void {
    this.entries.push({ level: 'error', context, message });
  }
  text(): string {
    return JSON.stringify(this.entries);
  }
}

export interface TestRuntime extends Runtime {
  http: RecordingHttp;
  logger: MemoryLogger;
}

export function nodeRuntime(http: HttpClient = fetchHttp): TestRuntime {
  return {
    http: new RecordingHttp(http),
    now: () => Date.now(),
    setTimer: (callback, ms) => {
      const handle = setTimeout(callback, ms);
      return () => clearTimeout(handle);
    },
    random: Math.random,
    logger: new MemoryLogger(),
  };
}

export interface Harness {
  portal: RunningPortal;
  runtime: TestRuntime;
  client: StalkerClient;
  close(): Promise<void>;
}

/** Portail factice + client branché dessus, avec l'URL telle qu'un utilisateur la saisirait. */
export async function harness(
  portalOverrides: FakePortalConfigInput = {},
  clientOverrides: Partial<StalkerClientOptions> = {},
): Promise<Harness> {
  const portal = await startPortal(portalOverrides);
  const runtime = nodeRuntime();
  const client = new StalkerClient(
    { portalUrl: `${portal.baseUrl}/stalker_portal/c/`, mac: TEST_MAC, ...clientOverrides },
    runtime,
  );
  return {
    portal,
    runtime,
    client,
    close: async () => {
      client.close();
      // Certains tests ferment eux-mêmes le portail pour simuler une panne.
      await portal.close().catch(() => undefined);
    },
  };
}

/** Lit les premiers octets d'un flux puis coupe : suffit à prouver qu'un lien est lisible. */
export function firstBytes(url: string, count = 188): Promise<{ status: number; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(url, (res) => {
      let buf = Buffer.alloc(0);
      const finish = (): void => {
        req.destroy();
        resolve({ status: res.statusCode ?? 0, bytes: buf });
      };
      res.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length >= count) finish();
      });
      res.on('end', finish);
    });
    req.on('error', reject);
    req.end();
  });
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
