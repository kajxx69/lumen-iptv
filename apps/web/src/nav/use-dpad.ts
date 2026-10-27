import { useEffect } from 'react';
import { type Direction, type NavAction, actionForKey, pickNeighbor } from './spatial.js';

/**
 * Tout élément interactif porte `data-nav` : il est alors joignable aux flèches. Un écran
 * peut désigner son point d'entrée avec `data-nav-default`. Une zone `data-nav-scope`
 * (panneau ouvert par-dessus) retient le focus tant qu'elle est affichée.
 */
const NAV_SELECTOR = '[data-nav]';
const DIRECTIONS = new Set<NavAction>(['up', 'down', 'left', 'right']);

function isVisible(el: HTMLElement): boolean {
  if (el.closest('[inert]') !== null) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function candidates(): HTMLElement[] {
  const scopes = document.querySelectorAll<HTMLElement>('[data-nav-scope]');
  const root: ParentNode = scopes.length > 0 ? (scopes[scopes.length - 1] ?? document) : document;
  return [...root.querySelectorAll<HTMLElement>(NAV_SELECTOR)].filter(
    (el) => !(el as HTMLButtonElement).disabled && isVisible(el),
  );
}

export function focusDefault(): boolean {
  const all = candidates();
  const target = all.find((el) => el.hasAttribute('data-nav-default')) ?? all[0];
  target?.focus();
  return target !== undefined;
}

/** Déplace le focus vers le voisin dans `dir` ; faux s'il n'y en a pas (bord de l'écran). */
export function moveFocus(dir: Direction): boolean {
  const all = candidates();
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !all.includes(active)) return focusDefault();
  const others = all.filter((el) => el !== active);
  const index = pickNeighbor(
    active.getBoundingClientRect(),
    others.map((el) => el.getBoundingClientRect()),
    dir,
  );
  const next = others[index];
  if (next === undefined) return false;
  next.focus({ preventScroll: true });
  // Défilement instantané : une liste virtualisée rend aussitôt les lignes suivantes.
  next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  return true;
}

const isTyping = (el: Element | null): boolean =>
  el instanceof HTMLInputElement ||
  el instanceof HTMLTextAreaElement ||
  (el instanceof HTMLElement && el.isContentEditable);

/** Les boutons et liens réagissent déjà à Entrée : seuls les autres éléments `data-nav` reçoivent un clic. */
const clicksNatively = (el: Element): boolean =>
  el instanceof HTMLButtonElement || el instanceof HTMLAnchorElement;

/**
 * Navigation clavier et télécommande pour toute l'application. Un composant qui gère une
 * touche lui-même (le lecteur, une liste) appelle `preventDefault()` et l'emporte.
 */
export function useDpad(onBack: () => void): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const action = actionForKey(event.key);
      if (action === undefined) return;
      const active = document.activeElement;
      const typing = isTyping(active);
      if (action === 'back') {
        // Dans un champ, Retour arrière efface ; Échap quitte le champ.
        if (typing && event.key === 'Backspace') return;
        event.preventDefault();
        onBack();
        return;
      }
      if (typing && (action === 'left' || action === 'right' || event.key === ' ')) return;
      if (DIRECTIONS.has(action)) {
        if (moveFocus(action as Direction)) event.preventDefault();
        return;
      }
      if (
        action === 'select' &&
        active instanceof HTMLElement &&
        active.matches(NAV_SELECTOR) &&
        !clicksNatively(active)
      ) {
        event.preventDefault();
        active.click();
      }
    };
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
    };
  }, [onBack]);
}
