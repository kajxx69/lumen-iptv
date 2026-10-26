/**
 * Interface commune à toutes les sources (Stalker d'abord, Xtream et M3U ensuite).
 * Le reste du système ne connaît que ces types : aucun détail de protocole n'en sort.
 */

export type StreamKind = 'live' | 'vod' | 'episode' | 'radio' | 'archive';
export type StreamFormat = 'ts' | 'hls' | 'unknown';

/** Référence opaque vers un flux ; seule la source qui l'a émise sait la résoudre. */
export interface StreamRef {
  providerId: string;
  kind: StreamKind;
  cmd: string;
}

/**
 * URL de lecture éphémère, liée à la session : à régénérer à chaque lecture et à
 * chaque reconnexion, jamais à persister.
 */
export interface ResolvedStream {
  url: string;
  format: StreamFormat;
  kind: StreamKind;
  resolvedAt: number;
}

export interface Session {
  providerId: string;
  status: 'active';
  /** Fin d'abonnement annoncée par la source, en ms Unix ; null si inconnue. */
  expiresAt: number | null;
  openedAt: number;
}

export interface ListOptions {
  categoryId?: string;
  search?: string;
  /** Reprise d'un listing interrompu (voir PaginationError). */
  startPage?: number;
}

export interface Channel {
  providerId: string;
  id: string;
  name: string;
  number: number;
  categoryId: string;
  logoUrl: string | null;
  epgId: string | null;
  /** Profondeur d'archive (catch-up), 0 si la chaîne n'en a pas. */
  archiveHours: number;
  censored: boolean;
  stream: StreamRef;
}

export interface VodItem {
  providerId: string;
  id: string;
  name: string;
  description: string;
  year: number | null;
  durationMin: number | null;
  rating: number | null;
  categoryId: string;
  posterUrl: string | null;
  censored: boolean;
  stream: StreamRef;
}

export interface TimeWindow {
  from: number;
  to: number;
}

export interface EpgEntry {
  id: string;
  channelId: string;
  title: string;
  description: string;
  category: string;
  start: number;
  end: number;
  /** Référence de lecture en différé, null si le programme n'est pas archivé. */
  catchup: StreamRef | null;
}

export interface ProviderCapabilities {
  live: boolean;
  vod: boolean;
  series: boolean;
  radio: boolean;
  epg: boolean;
  archive: boolean;
  favorites: boolean;
}

export interface SourceProvider {
  authenticate(): Promise<Session>;
  listChannels(opts?: ListOptions): AsyncIterable<Channel>;
  listVod(opts?: ListOptions): AsyncIterable<VodItem>;
  resolveStream(ref: StreamRef): Promise<ResolvedStream>;
  getEpg(channelId: string, window: TimeWindow): Promise<EpgEntry[]>;
  capabilities(): ProviderCapabilities;
}
