import { findProgress, useMovieDetail, useProgress } from '../api/vod-queries.js';
import { Poster } from '../components/PosterGrid.js';
import { formatClock } from '../player/vod-timeline.js';
import { goBack, navigate } from '../state/router.js';

/** Fiche d'un film : affiche, synopsis, reprise ou lecture depuis le début. */
export function MovieScreen({ portalId, movieId }: { portalId: string; movieId: string }) {
  const movie = useMovieDetail(portalId, movieId);
  const progress = useProgress();
  const saved = findProgress(progress.data, 'movie', portalId, movieId);
  const resumable = saved !== undefined && !saved.finished;

  if (movie.data === undefined) {
    return (
      <div className="empty">
        {movie.isError ? `Fiche indisponible : ${movie.error.message}` : 'Chargement de la fiche…'}
      </div>
    );
  }
  const m = movie.data;
  const facts = [
    m.year === null ? null : String(m.year),
    m.durationMin === null ? null : `${m.durationMin} min`,
    m.rating === null ? null : `★ ${m.rating.toFixed(1)}`,
  ].filter((f): f is string => f !== null);
  const play = (startS: number | null): void => {
    navigate({ name: 'play', item: { kind: 'movie', portalId, movieId }, startS });
  };

  return (
    <div className="detail screen" data-testid="movie-detail">
      <div className="detail-poster">
        <Poster src={m.poster} title={m.name} />
      </div>
      <div className="detail-body">
        <h1>{m.name}</h1>
        {m.originalName !== '' && m.originalName !== m.name && (
          <p className="programme-now">{m.originalName}</p>
        )}
        {facts.length > 0 && <p className="detail-facts">{facts.join(' · ')}</p>}
        <div className="actions">
          {resumable ? (
            <>
              <button
                type="button"
                className="button primary"
                data-nav
                data-nav-default
                data-testid="resume"
                onClick={() => {
                  play(null);
                }}
              >
                ▶ Reprendre à {formatClock(saved.positionS)}
              </button>
              <button
                type="button"
                className="button"
                data-nav
                onClick={() => {
                  play(0);
                }}
              >
                Depuis le début
              </button>
            </>
          ) : (
            <button
              type="button"
              className="button primary"
              data-nav
              data-nav-default
              data-testid="play"
              onClick={() => {
                play(0);
              }}
            >
              ▶ Lecture
            </button>
          )}
          <button type="button" className="button" data-nav onClick={goBack}>
            Retour
          </button>
        </div>
        {resumable && saved.durationS > 0 && (
          <div className="detail-progress" aria-label="Avancement">
            <span style={{ width: `${Math.round((100 * saved.positionS) / saved.durationS)}%` }} />
          </div>
        )}
        {m.description !== '' && <p className="detail-text">{m.description}</p>}
        {m.director !== '' && (
          <p className="detail-credits">
            <strong>Réalisation :</strong> {m.director}
          </p>
        )}
        {m.actors !== '' && (
          <p className="detail-credits">
            <strong>Avec :</strong> {m.actors}
          </p>
        )}
      </div>
    </div>
  );
}
