import { describe, expect, it } from 'vitest';
import {
  StalkerError,
  detectStreamFormat,
  parseChannel,
  parseGenres,
  parseHandshake,
  parsePage,
  parseProfile,
  parseProgramme,
  stripCmdPrefix,
  unwrapEnvelope,
} from '../../stalker/index.js';

/**
 * Le parseur doit accepter tout ce que les portails réels renvoient :
 * enveloppe `js` absente, nombres en chaînes, tableaux vides, `false` à la place d'une liste.
 * Il ne doit jamais exposer de donnée brute ni planter sur une entrée isolée invalide.
 */
describe('parseur défensif', () => {
  describe('enveloppe', () => {
    it('extrait js quand il est présent', () => {
      expect(unwrapEnvelope({ js: { token: 'A' } })).toEqual({ token: 'A' });
    });
    it('accepte une réponse sans enveloppe js', () => {
      expect(unwrapEnvelope({ token: 'A' })).toEqual({ token: 'A' });
      expect(unwrapEnvelope([1, 2])).toEqual([1, 2]);
    });
  });

  describe('chaîne', () => {
    it('convertit les nombres en chaîne, normalise les drapeaux', () => {
      const c = parseChannel({
        id: '42',
        name: 'FR | SAVANE INFO HD',
        number: '7',
        cmd: 'ffmpeg http://localhost/ch/42_',
        tv_genre_id: '2',
        logo: 'http://x/logos/1.png',
        xmltv_id: 'savaneinfo.fr',
        tv_archive: '1',
        tv_archive_duration: '72',
        censored: '0',
        fav: 1,
      });
      expect(c).toEqual({
        id: '42',
        name: 'FR | SAVANE INFO HD',
        number: 7,
        cmd: 'ffmpeg http://localhost/ch/42_',
        genreId: '2',
        logo: 'http://x/logos/1.png',
        xmltvId: 'savaneinfo.fr',
        archive: true,
        archiveHours: 72,
        censored: false,
        favorite: true,
      });
    });

    it('accepte des nombres natifs et remplit les champs absents par défaut', () => {
      expect(parseChannel({ id: 42, name: 'X', cmd: 'c' })).toMatchObject({
        id: '42',
        number: 0,
        genreId: '',
        logo: '',
        archive: false,
        archiveHours: 0,
        favorite: false,
      });
    });

    it('rejette une chaîne sans identifiant ou sans commande de lecture', () => {
      expect(parseChannel({ name: 'X', cmd: 'c' })).toBeNull();
      expect(parseChannel({ id: '1', name: 'X' })).toBeNull();
      expect(parseChannel(null)).toBeNull();
      expect(parseChannel('n importe quoi')).toBeNull();
    });

    it('tolère null, des valeurs non numériques et des types inattendus', () => {
      expect(
        parseChannel({ id: '1', name: null, cmd: 'c', number: 'abc', tv_archive: null, logo: {} }),
      ).toMatchObject({
        name: '',
        number: 0,
        archive: false,
        logo: '',
      });
    });
  });

  describe('page', () => {
    const page = (
      body: unknown,
    ): ReturnType<typeof parsePage<NonNullable<ReturnType<typeof parseChannel>>>> =>
      parsePage(body, parseChannel);

    it('lit total, taille de page et données', () => {
      const p = page({ total_items: '30', max_page_items: '14', cur_page: '1', data: [{ id: 1, cmd: 'c' }] });
      expect(p).toMatchObject({ totalItems: 30, pageSize: 14, invalidItems: 0 });
      expect(p.items).toHaveLength(1);
    });

    it('accepte data à false, null, absent, ou un objet indexé', () => {
      expect(page({ total_items: 0, data: false }).items).toEqual([]);
      expect(page({ total_items: 0, data: null }).items).toEqual([]);
      expect(page({}).items).toEqual([]);
      expect(
        page({ data: { 0: { id: 1, cmd: 'a' }, 1: { id: 2, cmd: 'b' } } }).items.map((c) => c.id),
      ).toEqual(['1', '2']);
    });

    it('écarte les entrées invalides sans perdre les autres, et les compte', () => {
      const p = page({ total_items: 3, data: [{ id: 1, cmd: 'a' }, 'déchet', { id: 3, cmd: 'c' }] });
      expect(p.items.map((c) => c.id)).toEqual(['1', '3']);
      expect(p.invalidItems).toBe(1);
    });

    it('accepte une liste nue en guise de page (portail sans pagination)', () => {
      const p = page([
        { id: 1, cmd: 'a' },
        { id: 2, cmd: 'b' },
      ]);
      expect(p.items).toHaveLength(2);
      expect(p.totalItems).toBe(2);
    });
  });

  describe('genres', () => {
    it('accepte la catégorie « tout » et un tableau vide', () => {
      expect(
        parseGenres([
          { id: '*', title: 'Tout' },
          { id: 2, title: 'Sport', censored: '1' },
        ]),
      ).toEqual([
        { id: '*', title: 'Tout', alias: '', censored: false },
        { id: '2', title: 'Sport', alias: '', censored: true },
      ]);
      expect(parseGenres([])).toEqual([]);
      expect(parseGenres(false)).toEqual([]);
    });
  });

  describe('handshake et profil', () => {
    it('exige un token non vide', () => {
      expect(parseHandshake({ token: 'ABC' })).toBe('ABC');
      expect(() => parseHandshake({ token: '' })).toThrow(StalkerError);
      expect(() => parseHandshake([])).toThrow(StalkerError);
      try {
        parseHandshake({});
      } catch (err) {
        expect(err).toBeInstanceOf(StalkerError);
        expect((err as StalkerError).kind).toBe('invalid_response');
      }
    });

    it('lit le statut et la date d expiration du compte', () => {
      const p = parseProfile({ status: '2', expire_billing_date: '2026-12-31 23:59:00', stb_type: 'MAG250' });
      expect(p.status).toBe(2);
      expect(p.expiresAt).toBe(Date.UTC(2026, 11, 31, 23, 59, 0));
      expect(parseProfile({}).status).toBe(0);
      expect(parseProfile({ expire_billing_date: '0000-00-00 00:00:00' }).expiresAt).toBeNull();
    });
  });

  describe('programme EPG', () => {
    it('privilégie les horodatages Unix et marque l archive', () => {
      const p = parseProgramme({
        id: '9_1700000000_60',
        ch_id: '9',
        name: 'Journal',
        start_timestamp: '1700000000',
        stop_timestamp: 1700003600,
        mark_archive: '1',
        cmd: 'auto /media/9_1700000000_60.mpg',
      });
      expect(p).toMatchObject({
        channelId: '9',
        start: 1_700_000_000_000,
        end: 1_700_003_600_000,
        archived: true,
      });
    });

    it('se rabat sur time / time_to quand les horodatages manquent', () => {
      const p = parseProgramme({
        id: 1,
        ch_id: 1,
        name: 'X',
        time: '2026-01-02 10:00:00',
        time_to: '2026-01-02 11:30:00',
      });
      expect(p?.start).toBe(Date.UTC(2026, 0, 2, 10));
      expect(p?.end).toBe(Date.UTC(2026, 0, 2, 11, 30));
    });

    it('accepte une date sans secondes', () => {
      const p = parseProgramme({ id: 1, name: 'X', time: '2026-01-02 10:00', time_to: '2026-01-02 10:45' });
      expect(p?.start).toBe(Date.UTC(2026, 0, 2, 10));
      expect(p?.end).toBe(Date.UTC(2026, 0, 2, 10, 45));
    });

    it('rejette un programme sans bornes exploitables', () => {
      expect(parseProgramme({ id: 1, name: 'X' })).toBeNull();
    });
  });
});

describe('liens de lecture', () => {
  it.each([
    ['ffmpeg http://h/play/live.php?a=1', 'http://h/play/live.php?a=1'],
    ['auto http://h/x.m3u8', 'http://h/x.m3u8'],
    ['ffrt http://h/x', 'http://h/x'],
    ['  http://h/x  ', 'http://h/x'],
    ['http://h/x', 'http://h/x'],
    ['ffmpeg   https://h/x', 'https://h/x'],
  ])('« %s » → « %s »', (cmd, url) => {
    expect(stripCmdPrefix(cmd)).toBe(url);
  });

  it('rejette une commande sans URL exploitable', () => {
    expect(() => stripCmdPrefix('ffmpeg ')).toThrow(StalkerError);
    expect(() => stripCmdPrefix('ffmpeg /media/1.mpg')).toThrow(StalkerError);
  });

  it('devine le format à partir de l URL', () => {
    expect(detectStreamFormat('http://h/play/live.php?stream=1&extension=ts&t=x')).toBe('ts');
    expect(detectStreamFormat('http://h/play/live.php?stream=1&extension=m3u8')).toBe('hls');
    expect(detectStreamFormat('http://h/live/1/index.m3u8?token=x')).toBe('hls');
    expect(detectStreamFormat('http://h/movie/1.mkv')).toBe('unknown');
    expect(detectStreamFormat('http://h/1.ts')).toBe('ts');
  });
});
