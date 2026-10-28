import { create } from 'zustand';
import { type Route, parseRoute, routePath } from './routes.js';

export { type Route, parseRoute, routePath };

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
