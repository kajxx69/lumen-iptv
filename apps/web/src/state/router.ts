import { create } from 'zustand';

/** Écrans de l'application ; l'URL reflète l'écran pour que « retour » et le rechargement marchent. */
export type Route =
  | { name: 'home' }
  | { name: 'tv'; genre: string | null }
  | { name: 'guide'; genre: string | null }
  | { name: 'settings' }
  | { name: 'login' }
  | { name: 'watch'; portalId: string; channelId: string };

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
    case 'regarder':
      if (parts[1] !== undefined && parts[2] !== undefined) {
        return { name: 'watch', portalId: parts[1], channelId: parts[2] };
      }
      return { name: 'home' };
    default:
      return { name: 'home' };
  }
}

export function routePath(route: Route): string {
  const genre = (g: string | null): string => (g === null ? '' : `?genre=${encodeURIComponent(g)}`);
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
  }
}

interface RouterState {
  route: Route;
  /** Profondeur de navigation dans l'application : sans historique propre, « retour » mène à l'accueil. */
  depth: number;
}

export const useRouter = create<RouterState>(() => ({
  route: parseRoute(window.location.pathname, window.location.search),
  depth: 0,
}));

export function navigate(route: Route, options: { replace?: boolean } = {}): void {
  const path = routePath(route);
  if (options.replace === true) {
    window.history.replaceState({ depth: useRouter.getState().depth }, '', path);
    useRouter.setState({ route });
    return;
  }
  const depth = useRouter.getState().depth + 1;
  window.history.pushState({ depth }, '', path);
  useRouter.setState({ route, depth });
}

export function goBack(): void {
  if (useRouter.getState().depth > 0) window.history.back();
  else if (useRouter.getState().route.name !== 'home') navigate({ name: 'home' }, { replace: true });
}

window.addEventListener('popstate', (event) => {
  const state = event.state as { depth?: number } | null;
  useRouter.setState({
    route: parseRoute(window.location.pathname, window.location.search),
    depth: state?.depth ?? 0,
  });
});
