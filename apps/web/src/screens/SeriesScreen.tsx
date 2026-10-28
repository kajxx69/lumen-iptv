import { useEpisodes, useProgress, useSeriesDetail } from '../api/vod-queries.js';
import { Poster } from '../components/PosterGrid.js';
import { episodeLabel, formatClock } from '../player/vod-timeline.js';
import { navigate } from '../state/router.js';

/** Fiche d'une série : saisons, épisodes avec leur avancement, reprise du dernier épisode. */
export function SeriesScreen({
  portalId,
  seriesId,
  seasonId,
}: {
  portalId: string;
  seriesId: string;
  seasonId: string | null;
}) {
  const series = useSeriesDetail(portalId, seriesId);
  const progress = useProgress();
  // Dernier épisode regardé de cette série (la liste est triée du plus récent au plus ancien).
  const watched = (progress.data ?? []).filter(
    (p) => p.kind === 'episode' && p.portalId === portalId && p.seriesId === seriesId,
  );
  const last = watched[0];
  const seasons = series.data?.seasons ?? [];
  const current = seasonId ?? last?.seasonId ?? seasons[0]?.id ?? null;
  const episodes = useEpisodes(portalId, seriesId, current);

  if (series.data === undefined) {
    return (
      <div className="empty">
        {series.isError ? `Fiche indisponible : ${series.error.message}` : 'Chargement de la série…'}
      </div>
    );
  }
  const s = series.data;
  const play = (season: string, episodeId: string, startS: number | null): void => {
    navigate({
      name: 'play',
      item: { kind: 'episode', portalId, seriesId, seasonId: season, episodeId },
      startS,
    });
  };

  return (
    <div className="detail screen" data-testid="series-detail">
      <div className="detail-poster">
        <Poster src={s.poster} title={s.name} />
      </div>
      <div className="detail-body">
        <h1>{s.name}</h1>
        {s.year !== null && <p className="detail-facts">{s.year}</p>}
        {last !== undefined && last.seasonId !== null && !last.finished && (
          <div className="actions">
            <button
              type="button"
              className="button primary"
              data-nav
              data-nav-default
              data-testid="resume"
              onClick={() => {
                play(last.seasonId ?? '', last.itemId, null);
              }}
            >
              ▶ Reprendre {last.label ?? 'l’épisode'} à {formatClock(last.positionS)}
            </button>
          </div>
        )}
        {s.description !== '' && <p className="detail-text">{s.description}</p>}
        <div className="season-tabs" role="tablist" aria-label="Saisons">
          {seasons.map((season) => (
            <button
              key={season.id}
              type="button"
              role="tab"
              className="genre"
              data-nav
              aria-selected={season.id === current}
              onClick={() => {
                navigate({ name: 'show', portalId, seriesId, seasonId: season.id }, { replace: true });
              }}
            >
              Saison {season.number}
            </button>
          ))}
        </div>
        <ol className="episodes" data-testid="episodes">
          {(episodes.data ?? []).map((ep, i) => {
            const season = seasons.find((x) => x.id === current);
            const saved = watched.find((p) => p.itemId === ep.id);
            return (
              <li key={ep.id}>
                <button
                  type="button"
                  className="episode"
                  data-nav
                  {...(last === undefined && i === 0 ? { 'data-nav-default': true } : {})}
                  data-testid="episode"
                  onClick={() => {
                    if (current !== null) play(current, ep.id, saved?.finished === false ? null : 0);
                  }}
                >
                  <span>{episodeLabel(season?.number ?? 0, ep.number, ep.name)}</span>
                  {saved !== undefined && (
                    <span className="programme-now">
                      {saved.finished ? '✓ Vu' : `Arrêté à ${formatClock(saved.positionS)}`}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
        {episodes.isLoading && <p className="programme-now">Chargement des épisodes…</p>}
      </div>
    </div>
  );
}
