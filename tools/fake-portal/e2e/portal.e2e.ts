import { expect, test } from '@playwright/test';

const MAC = '00:1A:79:00:00:99';
const headers = (token?: string): Record<string, string> => ({
  Cookie: `mac=${encodeURIComponent(MAC)}; stb_lang=fr; timezone=Africa%2FAbidjan`,
  'User-Agent':
    'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
  'X-User-Agent': 'Model: MAG250; Link: WiFi',
  ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
});
const API = '/stalker_portal/server/load.php';

test('le faux portail lancé comme processus répond au handshake et sert un flux gelable', async ({
  request,
}) => {
  await request.post('/_chaos/reset');

  const handshake = await request.get(`${API}?type=stb&action=handshake`, { headers: headers() });
  expect(handshake.status()).toBe(200);
  const { js } = (await handshake.json()) as { js: { token: string } };

  const profile = await request.get(`${API}?type=stb&action=get_profile`, { headers: headers(js.token) });
  expect(((await profile.json()) as { js: { status: string } }).js.status).toBe('0');

  const link = await request.get(
    `${API}?type=itv&action=create_link&cmd=${encodeURIComponent('ffmpeg http://localhost/ch/1_')}`,
    {
      headers: headers(js.token),
    },
  );
  const cmd = ((await link.json()) as { js: { cmd: string } }).js.cmd.replace(/^(ffmpeg|auto)\s+/, '');
  // Variante HLS : un flux TS continu ne se termine jamais, ce qui bloquerait `request.get`.
  const playlistRes = await request.get(cmd.replace('extension=ts', 'extension=m3u8'));
  expect(playlistRes.status()).toBe(200);
  const segment = (await playlistRes.text())
    .split('\n')
    .filter((l) => l.startsWith('/hls/'))
    .at(-1);
  expect(segment).toBeDefined();
  const body = await (await request.get(segment!)).body();
  expect(body[0]).toBe(0x47);

  const freeze = await request.post('/_chaos/freeze', { data: { durationMs: 8000 } });
  expect(freeze.status()).toBe(200);
  const state = (await (await request.get('/_chaos/state')).json()) as { freezes: unknown[] };
  expect(state.freezes).toHaveLength(1);
  await request.post('/_chaos/reset');
});
