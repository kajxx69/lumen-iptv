import { useQueryClient } from '@tanstack/react-query';
import { Suspense, lazy, useEffect, useState } from 'react';
import { onUnauthorized } from './api/client.js';
import { useMe, usePortalHealth } from './api/queries.js';
import { useDpad } from './nav/use-dpad.js';
import { GuideScreen } from './screens/GuideScreen.js';
import { HomeScreen } from './screens/HomeScreen.js';
import { LiveScreen } from './screens/LiveScreen.js';
import { LoginScreen } from './screens/LoginScreen.js';
import { SettingsScreen } from './screens/SettingsScreen.js';
/**
 * Le lecteur (hls.js, le plus gros module) n'est téléchargé qu'au lancement d'une chaîne :
 * l'ouverture de l'application coûte moitié moins de données mobiles.
 */
const WatchScreen = lazy(() => import('./screens/WatchScreen.js').then((m) => ({ default: m.WatchScreen })));
import { type Route, goBack, navigate, useRouter } from './state/router.js';
import { useCurrentPortal } from './state/use-current-portal.js';
import { usePrefs } from './state/prefs.js';

function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = (): void => {
      setOnline(navigator.onLine);
    };
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

const TABS: { label: string; route: Route }[] = [
  { label: 'Accueil', route: { name: 'home' } },
  { label: 'TV en direct', route: { name: 'tv', genre: null } },
  { label: 'Guide', route: { name: 'guide', genre: null } },
  { label: 'Réglages', route: { name: 'settings' } },
];

const MINUTE_MS = 60_000;

/** « Il y a 12 min », « il y a 3 h » : l'âge du catalogue affiché, en clair. */
function ago(ms: number): string {
  const minutes = Math.max(1, Math.round((Date.now() - ms) / MINUTE_MS));
  return minutes < 90 ? `il y a ${minutes} min` : `il y a ${Math.round(minutes / 60)} h`;
}

/**
 * Portail qui ne répond plus : la liste reste utilisable (copie de la dernière
 * synchronisation) et l'utilisateur sait pourquoi une chaîne pourrait ne pas démarrer.
 */
function PortalBanner({ portalId, name }: { portalId: string; name: string }) {
  const health = usePortalHealth(portalId);
  if (health.data === undefined || health.data.reachable) return null;
  const synced = health.data.syncedAt;
  return (
    <span className="banner" role="status">
      Portail « {name} » injoignable
      {synced === null ? '' : ` : chaînes de la dernière synchronisation (${ago(synced)})`}. Nouvel essai
      automatique.
    </span>
  );
}

function Header({ current }: { current: Route['name'] }) {
  const online = useOnline();
  const { portal, portals } = useCurrentPortal();
  const setPortal = usePrefs((s) => s.setPortal);
  return (
    <header className="header">
      <span className="brand">LUMEN</span>
      {TABS.map((tab) => (
        <button
          key={tab.route.name}
          type="button"
          className="nav-link"
          data-nav
          aria-current={current === tab.route.name ? 'page' : undefined}
          onClick={() => {
            navigate(tab.route);
          }}
        >
          {tab.label}
        </button>
      ))}
      <span className="spacer" />
      {!online && <span className="banner">Hors ligne : catalogue local</span>}
      {online && portal !== null && <PortalBanner portalId={portal.id} name={portal.name} />}
      {portals.length > 1 && (
        <button
          type="button"
          className="nav-link"
          data-nav
          title="Changer de portail"
          onClick={() => {
            const index = portals.findIndex((p) => p.id === portal?.id);
            const next = portals[(index + 1) % portals.length];
            if (next !== undefined) setPortal(next.id);
          }}
        >
          {portal?.name ?? ''} ⇄
        </button>
      )}
    </header>
  );
}

function Screen({ route }: { route: Route }) {
  switch (route.name) {
    case 'home':
      return <HomeScreen />;
    case 'tv':
      return <LiveScreen genre={route.genre} />;
    case 'guide':
      return <GuideScreen genre={route.genre} />;
    case 'settings':
      return <SettingsScreen />;
    case 'watch':
      return (
        <Suspense fallback={<div className="player" />}>
          <WatchScreen key="watch" portalId={route.portalId} channelId={route.channelId} />
        </Suspense>
      );
    case 'login':
      return <LoginScreen />;
  }
}

export function App() {
  const route = useRouter((s) => s.route);
  const me = useMe();
  const client = useQueryClient();
  useDpad(goBack);

  // Session expirée pendant l'utilisation : retour à la connexion, sans boucle d'erreurs.
  useEffect(
    () =>
      onUnauthorized(() => {
        client.setQueryData(['me'], null);
      }),
    [client],
  );

  const loggedOut = me.data === null;
  useEffect(() => {
    if (loggedOut && route.name !== 'login') navigate({ name: 'login' }, { replace: true });
  }, [loggedOut, route.name]);

  if (me.isLoading) return <div className="empty">Lumen…</div>;
  if (loggedOut || route.name === 'login') return <LoginScreen />;
  if (route.name === 'watch') return <Screen route={route} />;
  return (
    <div className="app">
      <Header current={route.name} />
      <main className="screen">
        <Screen route={route} />
      </main>
    </div>
  );
}
