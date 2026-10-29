import { describe, expect, it } from 'vitest';
import { parseRoute, routePath } from '../src/state/routes.js';
import {
  SERVER_BEHIND_SAFE_S,
  afterArchive,
  behindLiveS,
  endedEarly,
  episodeLabel,
  formatClock,
  nextEpisode,
  seekPlan,
} from '../src/player/vod-timeline.js';

describe('déplacement dans un film', () => {
  // Lecture lancée à 600 s : la vidéo commence à 0, le film à 600.
  const ctx = {
    offsetS: 600,
    currentTime: 40,
    buffered: [[0, 70]] as const,
    playlist: { start: 0, end: 90 },
  };

  it('dans ce qui est chargé : simple déplacement, sans relance', () => {
    expect(seekPlan(650, ctx)).toEqual({ kind: 'local', currentTime: 50 });
  });

  it('au-delà du chargé mais produit par le serveur : déplacement aussi', () => {
    expect(seekPlan(680, ctx)).toEqual({ kind: 'local', currentTime: 80 });
  });

  it('au-delà de ce que le serveur a produit : nouvelle lecture à cette position', () => {
    expect(seekPlan(1200, ctx)).toEqual({ kind: 'restart', startS: 1200 });
  });

  it('avant le début de cette lecture : nouvelle lecture', () => {
    expect(seekPlan(300, ctx)).toEqual({ kind: 'restart', startS: 300 });
  });

  it('loin derrière la position, hors chargé : le serveur a pu libérer, on relance', () => {
    // Chargé seulement de 70 à 90 ; la playlist annonce encore tout depuis 0.
    const late = { ...ctx, currentTime: 85, buffered: [[70, 90]] as const };
    expect(seekPlan(600 + 85 - SERVER_BEHIND_SAFE_S - 5, late).kind).toBe('restart');
    expect(seekPlan(600 + 85 - SERVER_BEHIND_SAFE_S + 1, late)).toEqual({ kind: 'local', currentTime: 66 });
  });
});

describe('fin, épisode suivant, affichage', () => {
  it('fin prématurée seulement loin de la fin réelle', () => {
    expect(endedEarly(30, 64)).toBe(true);
    expect(endedEarly(60, 64)).toBe(false);
    expect(endedEarly(30, null)).toBe(false);
  });

  const seasons = [
    { id: 's2', number: 2, name: 'Saison 2', episodeCount: 2 },
    { id: 's1', number: 1, name: 'Saison 1', episodeCount: 2 },
  ];
  const episodes = [
    { id: 'e1', number: 1, name: 'Un' },
    { id: 'e2', number: 2, name: 'Deux' },
  ];

  it('épisode suivant de la saison, puis première de la saison suivante, puis rien', () => {
    expect(nextEpisode(seasons, 's1', episodes, 'e1')).toEqual({ seasonId: 's1', episodeId: 'e2' });
    expect(nextEpisode(seasons, 's1', episodes, 'e2')).toEqual({ seasonId: 's2', episodeId: null });
    expect(nextEpisode(seasons, 's2', episodes, 'e2')).toBeNull();
  });

  it('horloge et repère d épisode', () => {
    expect(formatClock(5)).toBe('0:05');
    expect(formatClock(754)).toBe('12:34');
    expect(formatClock(3723)).toBe('1:02:03');
    expect(episodeLabel(2, 5, 'Le retour')).toBe('S2 · É5 — Le retour');
    expect(episodeLabel(1, 1, '')).toBe('S1 · É1');
  });
});

describe('adresses des écrans de films et séries', () => {
  it('aller-retour adresse ↔ écran', () => {
    const routes = [
      { name: 'movies', category: null },
      { name: 'movies', category: '3' },
      { name: 'series', category: null },
      { name: 'movie', portalId: 'p1', movieId: '42' },
      { name: 'show', portalId: 'p1', seriesId: '7', seasonId: null },
      { name: 'show', portalId: 'p1', seriesId: '7', seasonId: '7:2' },
      { name: 'play', item: { kind: 'movie', portalId: 'p1', movieId: '42' }, startS: null },
      { name: 'play', item: { kind: 'movie', portalId: 'p1', movieId: '42' }, startS: 120 },
      {
        name: 'play',
        item: { kind: 'episode', portalId: 'p1', seriesId: '7', seasonId: '7:2', episodeId: '7:2:3' },
        startS: null,
      },
      {
        name: 'play',
        item: {
          kind: 'archive',
          portalId: 'p1',
          channelId: '12',
          start: 1_700_000_000_000,
          end: 1_700_003_600_000,
        },
        startS: 600,
      },
      { name: 'search', query: '' },
      { name: 'search', query: 'matrix 1999' },
    ] as const;
    for (const route of routes) {
      const path = routePath(route);
      const [pathname = '', search = ''] = path.split('?');
      expect(parseRoute(pathname, search === '' ? '' : `?${search}`)).toEqual(route);
    }
  });
});

describe('fin d une émission archivée', () => {
  const H = 3_600_000;
  const now = 10 * H;
  const programmes = [
    { start: 7 * H, end: 8 * H, catchup: true },
    { start: 8 * H, end: 9 * H, catchup: true },
    { start: 9 * H, end: 11 * H, catchup: true },
  ];

  it('émission terminée : la suivante, depuis son début', () => {
    expect(afterArchive(programmes, { start: 7 * H, end: 8 * H }, 3600, now)).toEqual({
      kind: 'archive',
      start: 8 * H,
      end: 9 * H,
      startS: 0,
    });
  });

  it('émission encore à l antenne, loin du direct : l archive reprend au même point', () => {
    const current = { start: 9 * H, end: 11 * H };
    expect(afterArchive(programmes, current, 1200, now)).toEqual({
      ...current,
      kind: 'archive',
      startS: 1200,
    });
    expect(behindLiveS(current.start, 1200, now)).toBe(2400);
  });

  it('presque rattrapé : retour au direct', () => {
    expect(afterArchive(programmes, { start: 9 * H, end: 11 * H }, 3600 - 30, now)).toEqual({ kind: 'live' });
  });

  it('suivante pas encore commencée ou inconnue : le direct', () => {
    expect(afterArchive([], { start: 7 * H, end: 8 * H }, 3600, now)).toEqual({ kind: 'live' });
  });
});
