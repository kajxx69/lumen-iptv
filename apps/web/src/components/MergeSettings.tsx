import { ALL_PORTALS_ID, type ChannelDto, type ChannelSourceDto, MERGE_SOLO_TARGET } from '@lumen/protocol';
import { useDeferredValue, useMemo, useState } from 'react';
import { useMergeSettings, usePortals, useSetMergeEnabled, useSetMergeOverride } from '../api/queries.js';
import { useCatalog } from '../catalog/use-catalog.js';

/** Résultats de recherche montrés : assez pour trouver, assez peu pour rester lisible à la télécommande. */
const MAX_RESULTS = 20;

/**
 * Fusion des portails (Réglages). L'automatisme se trompera parfois (PROJECT.md) : on
 * cherche la chaîne, puis on sépare une source ou on la déplace vers la bonne chaîne.
 * Les corrections valent pour toute l'installation ; seul l'administrateur les fait.
 */
export function MergeSettings({ admin }: { admin: boolean }) {
  const settings = useMergeSettings();
  const setEnabled = useSetMergeEnabled();
  const setOverride = useSetMergeOverride();
  const portals = usePortals();
  const enabled = settings.data?.enabled === true;
  const { catalog } = useCatalog(enabled ? ALL_PORTALS_ID : null);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [moving, setMoving] = useState<ChannelSourceDto | null>(null);

  const portalName = (id: string): string => portals.data?.find((p) => p.id === id)?.name ?? 'portail retiré';
  const results = useMemo((): ChannelDto[] => {
    if (catalog === null || deferredQuery.trim() === '') return [];
    return catalog.search
      .search(deferredQuery)
      .slice(0, MAX_RESULTS)
      .map((id) => catalog.byId.get(id))
      .filter((c): c is ChannelDto => c !== undefined);
  }, [catalog, deferredQuery]);
  const sourceName = (ref: { portalId: string; channelId: string }): string =>
    catalog?.resolve(ref)?.sources?.find((s) => s.portalId === ref.portalId && s.channelId === ref.channelId)
      ?.name ?? ref.channelId;
  const correct = (ref: { portalId: string; channelId: string }, target: string | null): void => {
    setOverride.mutate({ portalId: ref.portalId, channelId: ref.channelId, target });
  };

  if (settings.data === undefined) return null;
  return (
    <section className="form" aria-labelledby="merge-title">
      <h2 id="merge-title">Fusion des portails</h2>
      <p className="programme-now">
        Une même chaîne présente sur plusieurs portails apparaît une seule fois dans « Tous les portails » ;
        ses autres sources servent de secours en cas de panne.
      </p>
      <button
        type="button"
        className={`button${enabled ? ' primary' : ''}`}
        data-nav
        aria-pressed={enabled}
        disabled={!admin || setEnabled.isPending}
        onClick={() => {
          setEnabled.mutate({ enabled: !enabled });
        }}
      >
        {enabled ? 'Fusion activée' : 'Fusion désactivée'}
      </button>

      {enabled && admin && (
        <>
          <label className="field">
            <span>Corriger un regroupement : chercher une chaîne</span>
            <input
              data-nav
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
              }}
              placeholder="Nom de la chaîne"
            />
          </label>
          {moving !== null && (
            <p className="banner" role="status">
              Déplacement de « {moving.name} » ({portalName(moving.portalId)}) : choisissez la chaîne qui doit
              l’accueillir.{' '}
              <button
                type="button"
                className="button"
                data-nav
                onClick={() => {
                  setMoving(null);
                }}
              >
                Annuler
              </button>
            </p>
          )}
          {results.map((c) => {
            const sources = c.sources ?? [];
            const hostsMoving =
              moving !== null &&
              !sources.some((s) => s.portalId === moving.portalId && s.channelId === moving.channelId);
            return (
              <div className="card merge-group" key={c.id}>
                <div className="card-body">
                  <strong>{c.name}</strong>
                  <small>
                    {sources.length} source{sources.length > 1 ? 's' : ''}
                  </small>
                  <ul className="merge-sources">
                    {sources.map((s) => (
                      <li key={`${s.portalId}:${s.channelId}`}>
                        <span>
                          {s.name} · {portalName(s.portalId)}
                        </span>
                        {sources.length > 1 && (
                          <button
                            type="button"
                            className="button"
                            data-nav
                            onClick={() => {
                              correct(s, MERGE_SOLO_TARGET);
                            }}
                          >
                            Séparer
                          </button>
                        )}
                        <button
                          type="button"
                          className="button"
                          data-nav
                          onClick={() => {
                            setMoving(s);
                          }}
                        >
                          Déplacer
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
                {hostsMoving && (
                  <button
                    type="button"
                    className="button primary"
                    data-nav
                    onClick={() => {
                      correct(moving, c.id);
                      setMoving(null);
                    }}
                  >
                    Ajouter ici
                  </button>
                )}
              </div>
            );
          })}
        </>
      )}

      {settings.data.overrides.length > 0 && (
        <>
          <h3>Corrections en place</h3>
          {settings.data.overrides.map((o) => (
            <div className="card" key={`${o.portalId}:${o.channelId}`}>
              <div className="card-body">
                <strong>
                  {sourceName(o)} · {portalName(o.portalId)}
                </strong>
                <small>
                  {o.target === MERGE_SOLO_TARGET
                    ? 'mise à part'
                    : `rattachée à « ${catalog?.byId.get(o.target)?.name ?? o.target} »`}
                </small>
              </div>
              {admin && (
                <button
                  type="button"
                  className="button"
                  data-nav
                  onClick={() => {
                    correct(o, null);
                  }}
                >
                  Annuler la correction
                </button>
              )}
            </div>
          ))}
        </>
      )}
    </section>
  );
}
