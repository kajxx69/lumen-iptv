import { describe, expect, it } from 'vitest';
import { FairQueue } from '../src/resilience/fair-queue.js';

/** Tâche contrôlée à la main : on décide quand elle se termine. */
function controlled() {
  const started: string[] = [];
  const finish = new Map<string, (value: string) => void>();
  const run = (item: string): Promise<string> =>
    new Promise((resolve) => {
      started.push(item);
      finish.set(item, resolve);
    });
  const end = async (item: string): Promise<void> => {
    finish.get(item)?.(`fait:${item}`);
    // Laisse la file servir la suivante.
    await new Promise((r) => setTimeout(r, 0));
  };
  return { started, run, end };
}

describe('file d analyse équitable entre relais', () => {
  it('une place libre : la tâche part tout de suite', async () => {
    const c = controlled();
    const q = new FairQueue(1, c.run);
    const done = q.submit('a', 'a1');
    expect(c.started).toEqual(['a1']);
    await c.end('a1');
    expect(await done).toBe('fait:a1');
  });

  it('places prises : seule la dernière demande de chaque relais attend, les plus anciennes passent leur tour', async () => {
    const c = controlled();
    const q = new FairQueue(1, c.run);
    void q.submit('a', 'a1');
    const a2 = q.submit('a', 'a2');
    const a3 = q.submit('a', 'a3');
    expect(await a2).toBeNull();
    await c.end('a1');
    expect(c.started).toEqual(['a1', 'a3']);
    await c.end('a3');
    expect(await a3).toBe('fait:a3');
  });

  it('chacun son tour : un relais très actif n affame pas les autres', async () => {
    const c = controlled();
    const q = new FairQueue(1, c.run);
    void q.submit('a', 'a1');
    void q.submit('a', 'a2');
    void q.submit('b', 'b1');
    void q.submit('c', 'c1');
    await c.end('a1');
    // « a » vient d'être servi : « b » et « c » passent avant sa demande suivante.
    expect(c.started).toEqual(['a1', 'b1']);
    void q.submit('b', 'b2');
    await c.end('b1');
    expect(c.started).toEqual(['a1', 'b1', 'c1']);
    await c.end('c1');
    expect(c.started).toEqual(['a1', 'b1', 'c1', 'a2']);
  });
});
