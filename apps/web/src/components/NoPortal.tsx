import { useMe } from '../api/queries.js';
import { navigate } from '../state/router.js';

/** Aucun portail enregistré : on guide vers les réglages plutôt que d'afficher une liste vide. */
export function NoPortal() {
  const me = useMe();
  return (
    <div className="empty">
      <p>Aucun portail n’est encore configuré.</p>
      {me.data?.role === 'admin' ? (
        <button
          type="button"
          className="button primary"
          data-nav
          data-nav-default
          onClick={() => {
            navigate({ name: 'settings' });
          }}
        >
          Ajouter un portail
        </button>
      ) : (
        <p>Demandez à l’administrateur d’ajouter votre abonnement.</p>
      )}
    </div>
  );
}
