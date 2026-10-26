import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { Writable } from 'node:stream';
import { type FakePortalConfigInput, type RunningPortal, sendChaos, startPortal } from '@lumen/fake-portal';
import type { PortalDto } from '@lumen/protocol';
import { type ServerConfigInput, resolveConfig } from '../src/config.js';
import { type LumenServer, createServer } from '../src/server.js';

export { sendChaos, startPortal, type RunningPortal };

export const ADMIN = { username: 'admin', password: 'admin-password-1' };
export const PORTAL_MAC = '00:1A:79:AB:CD:EF';

export interface ApiResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
  text: string;
}

/** Client de l'API Lumen tel que le sera le navigateur : un cookie de session, rien d'autre. */
export class ApiClient {
  cookie: string | undefined;

  constructor(readonly baseUrl: string) {}

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<ApiResponse<T>> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(this.cookie === undefined ? {} : { Cookie: this.cookie }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('lumen_session='));
    if (setCookie !== undefined) {
      const value = setCookie.split(';')[0] ?? '';
      this.cookie = value === 'lumen_session=' ? undefined : value;
    }
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Corps non JSON (flux, image, HTML) : laissé en texte.
    }
    return { status: res.status, headers: res.headers, body: parsed as T, text };
  }

  get<T = unknown>(path: string, headers?: Record<string, string>): Promise<ApiResponse<T>> {
    return this.request<T>('GET', path, undefined, headers);
  }

  post<T = unknown>(path: string, body: unknown = {}): Promise<ApiResponse<T>> {
    return this.request<T>('POST', path, body);
  }

  delete<T = unknown>(path: string): Promise<ApiResponse<T>> {
    return this.request<T>('DELETE', path);
  }

  async login(username: string, password: string): Promise<ApiResponse> {
    return this.post('/api/auth/login', { username, password });
  }
}

export interface TestServer {
  server: LumenServer;
  baseUrl: string;
  config: ServerConfigInput;
  /** Lignes de journal JSON émises par le serveur. */
  logs: string[];
  admin: ApiClient;
  client(): ApiClient;
  close(): Promise<void>;
}

export async function startServer(overrides: Partial<ServerConfigInput> = {}): Promise<TestServer> {
  const logs: string[] = [];
  const logStream = new Writable({
    write(chunk: Buffer, _enc, done): void {
      logs.push(
        ...chunk
          .toString()
          .split('\n')
          .filter((l) => l !== ''),
      );
      done();
    },
  });
  const config: ServerConfigInput = {
    host: '127.0.0.1',
    port: 0,
    databasePath: ':memory:',
    masterKey: randomBytes(32).toString('base64'),
    adminUsername: ADMIN.username,
    adminPassword: ADMIN.password,
    cookieSecure: false,
    logLevel: 'debug',
    ...overrides,
  };
  const server = await createServer(resolveConfig(config), { logStream });
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  const address = server.app.server.address();
  if (address === null || typeof address === 'string') throw new Error('adresse inattendue');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const admin = new ApiClient(baseUrl);
  const login = await admin.login(ADMIN.username, ADMIN.password);
  if (login.status !== 204) throw new Error(`connexion admin impossible : ${login.status}`);
  return {
    server,
    baseUrl,
    config,
    logs,
    admin,
    client: () => new ApiClient(baseUrl),
    close: () => server.close(),
  };
}

export async function addPortal(
  admin: ApiClient,
  portal: RunningPortal,
  extra: Record<string, unknown> = {},
): Promise<PortalDto> {
  const res = await admin.post<PortalDto>('/api/portals', {
    name: 'Portail de test',
    url: `${portal.baseUrl}/stalker_portal/c/`,
    mac: PORTAL_MAC,
    ...extra,
  });
  if (res.status !== 201) throw new Error(`ajout du portail : ${res.status} ${res.text}`);
  return res.body;
}

export interface Stack {
  portal: RunningPortal;
  srv: TestServer;
  portalDto: PortalDto;
  close(): Promise<void>;
}

/** Portail factice + backend + portail enregistré : la configuration d'un utilisateur réel. */
export async function startStack(
  portalOverrides: FakePortalConfigInput = {},
  serverOverrides: Partial<ServerConfigInput> = {},
  portalRequestExtra: Record<string, unknown> = {},
): Promise<Stack> {
  const portal = await startPortal(portalOverrides);
  const srv = await startServer(serverOverrides);
  const portalDto = await addPortal(srv.admin, portal, portalRequestExtra);
  return {
    portal,
    srv,
    portalDto,
    close: async () => {
      await srv.close();
      await portal.close().catch(() => undefined);
    },
  };
}

/** Lit les premiers octets d'un flux puis coupe. */
export function firstBytes(
  url: string,
  headers: Record<string, string> = {},
  count = 188 * 10,
): Promise<{ status: number; contentType: string; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, (res) => {
      let buf = Buffer.alloc(0);
      const finish = (): void => {
        req.destroy();
        resolve({
          status: res.statusCode ?? 0,
          contentType: res.headers['content-type'] ?? '',
          bytes: buf,
        });
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

export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
