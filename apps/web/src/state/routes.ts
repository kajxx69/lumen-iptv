import type { VodItemRef } from '@lumen/protocol';

/** Écrans de l'application ; l'URL reflète l'écran pour que « retour » et le rechargement marchent. */
export type Route =
  | { name: 'home' }
  | { name: 'tv'; genre: string | null }
  | { name: 'guide'; genre: string | null }
  | { name: 'settings' }
  | { name: 'login' }
  | { name: 'watch'; portalId: string; channelId: string }
  | { name: 'movies'; category: string | null }
  | { name: 'series'; category: string | null }
  | { name: 'movie'; portalId: string; movieId: string }
  | { name: 'show'; portalId: string; seriesId: string; seasonId: string | null }
  /** Lecture d'un film ou d'un épisode ; `startS` : position demandée (sinon, la reprise enregistrée). */
  | { name: 'play'; item: VodItemRef; startS: number | null }
  | { name: 'search'; query: string };

const positionParam = (value: string | null): number | null => {
  const n = value === null ? Number.NaN : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

export function parseRoute(path: string, search = ''): Route {
  const params = new URLSearchParams(search);
  const parts = path
    .split('/')
    .filter((p) => p !== '')
    .map(decodeURIComponent);
  switch (parts[0]) {
    case undefined:
      return { name: 'home' };
    case 'tv':
      return { name: 'tv', genre: params.get('genre') };
    case 'guide':
      return { name: 'guide', genre: params.get('genre') };
    case 'reglages':
      return { name: 'settings' };
    case 'connexion':
      return { name: 'login' };
    case 'films':
      if (parts[1] !== undefined && parts[2] !== undefined) {
        return { name: 'movie', portalId: parts[1], movieId: parts[2] };
      }
      return { name: 'movies', category: params.get('categorie') };
    case 'series':
      if (parts[1] !== undefined && parts[2] !== undefined) {
        return { name: 'show', portalId: parts[1], seriesId: parts[2], seasonId: params.get('saison') };
      }
      return { name: 'series', category: params.get('categorie') };
    case 'lire':
      if (parts[1] === 'film' && parts[2] !== undefined && parts[3] !== undefined) {
        return {
          name: 'play',
          item: { kind: 'movie', portalId: parts[2], movieId: parts[3] },
          startS: positionParam(params.get('t')),
        };
      }
      if (
        parts[1] === 'episode' &&
        parts[2] !== undefined &&
        parts[3] !== undefined &&
        parts[4] !== undefined &&
        parts[5] !== undefined
      ) {
        return {
          name: 'play',
          item: {
            kind: 'episode',
            portalId: parts[2],
            seriesId: parts[3],
            seasonId: parts[4],
            episodeId: parts[5],
          },
          startS: positionParam(params.get('t')),
        };
      }
      if (parts[1] === 'archive' && parts[2] !== undefined && parts[3] !== undefined) {
        const start = Number(parts[4]);
        const end = Number(parts[5]);
        if (Number.isInteger(start) && Number.isInteger(end) && end > start && start >= 0) {
          return {
            name: 'play',
            item: { kind: 'archive', portalId: parts[2], channelId: parts[3], start, end },
            startS: positionParam(params.get('t')),
          };
        }
      }
      return { name: 'home' };
    case 'recherche':
      return { name: 'search', query: params.get('q') ?? '' };
    case 'regarder':
      if (parts[1] !== undefined && parts[2] !== undefined) {
        return { name: 'watch', portalId: parts[1], channelId: parts[2] };
      }
      return { name: 'home' };
    default:
      return { name: 'home' };
  }
}

/** Adresse d'une lecture de film, d'épisode ou d'émission archivée ; `t` : position demandée. */
function playPath(i: VodItemRef, t: string): string {
  const e = encodeURIComponent;
  switch (i.kind) {
    case 'movie':
      return `/lire/film/${e(i.portalId)}/${e(i.movieId)}${t}`;
    case 'episode':
      return `/lire/episode/${e(i.portalId)}/${e(i.seriesId)}/${e(i.seasonId)}/${e(i.episodeId)}${t}`;
    case 'archive':
      return `/lire/archive/${e(i.portalId)}/${e(i.channelId)}/${i.start}/${i.end}${t}`;
  }
}

export function routePath(route: Route): string {
  const genre = (g: string | null): string => (g === null ? '' : `?genre=${encodeURIComponent(g)}`);
  const category = (c: string | null): string => (c === null ? '' : `?categorie=${encodeURIComponent(c)}`);
  const e = encodeURIComponent;
  switch (route.name) {
    case 'home':
      return '/';
    case 'tv':
      return `/tv${genre(route.genre)}`;
    case 'guide':
      return `/guide${genre(route.genre)}`;
    case 'settings':
      return '/reglages';
    case 'login':
      return '/connexion';
    case 'watch':
      return `/regarder/${encodeURIComponent(route.portalId)}/${encodeURIComponent(route.channelId)}`;
    case 'movies':
      return `/films${category(route.category)}`;
    case 'series':
      return `/series${category(route.category)}`;
    case 'movie':
      return `/films/${e(route.portalId)}/${e(route.movieId)}`;
    case 'show':
      return `/series/${e(route.portalId)}/${e(route.seriesId)}${route.seasonId === null ? '' : `?saison=${e(route.seasonId)}`}`;
    case 'play':
      return playPath(route.item, route.startS === null ? '' : `?t=${Math.floor(route.startS)}`);
    case 'search':
      return route.query === '' ? '/recherche' : `/recherche?q=${e(route.query)}`;
  }
}
