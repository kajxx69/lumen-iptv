import { afterEach, describe, expect, it } from 'vitest';
import { type TestServer, startServer } from './helpers.js';

const TOKEN = 'jeton-de-test-prometheus-0123';

describe('/metrics (Prometheus)', () => {
  let srv: TestServer | undefined;
  afterEach(async () => {
    await srv?.close();
    srv = undefined;
  });

  it('désactivé tant qu aucun jeton n est configuré', async () => {
    srv = await startServer();
    expect((await fetch(`${srv.baseUrl}/metrics`)).status).toBe(404);
  });

  it('exige le jeton, même pour un administrateur connecté', async () => {
    srv = await startServer({ metricsToken: TOKEN });
    expect((await fetch(`${srv.baseUrl}/metrics`)).status).toBe(401);
    expect((await srv.admin.get('/metrics')).status).toBe(401);
    const wrong = await fetch(`${srv.baseUrl}/metrics`, { headers: { Authorization: `Bearer ${TOKEN}x` } });
    expect(wrong.status).toBe(401);
  });

  it('expose les métriques du relais au format texte, sans identifiant de chaîne ni de portail', async () => {
    srv = await startServer({ metricsToken: TOKEN });
    const res = await fetch(`${srv.baseUrl}/metrics`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain; version=0\.0\.4/);
    const text = await res.text();
    for (const name of [
      'lumen_relay_upstream_connections',
      'lumen_relay_active',
      'lumen_relay_viewers',
      'lumen_relay_startup_seconds_bucket',
      'lumen_relay_recovery_seconds_count',
      'lumen_relay_source_switches_total',
      'lumen_link_resolution_failures_total',
      'lumen_relay_bytes_out_total',
      'lumen_playback_stall_seconds_total',
      'lumen_playback_watch_seconds_total',
      'process_cpu_seconds_total',
      'process_resident_memory_bytes',
    ]) {
      expect(text).toContain(name);
    }
    expect(text).not.toMatch(/portal|channel|user/i);
  });

  it('configuration : le jeton trop court est refusé au démarrage', async () => {
    await expect(startServer({ metricsToken: 'court' })).rejects.toThrow();
  });
});
