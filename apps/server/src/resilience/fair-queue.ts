interface Pending<T, R> {
  item: T;
  resolve: (result: R | null) => void;
}

/**
 * File d'attente équitable entre plusieurs demandeurs (les relais) pour une ressource rare
 * (les analyses FFmpeg) : au plus `maxConcurrent` tâches à la fois ; pour chaque demandeur,
 * seule sa dernière demande attend (les plus anciennes, dépassées, passent leur tour) ; et le
 * demandeur servi depuis le plus longtemps passe en premier. Un relais très actif n'affame
 * ainsi jamais les autres : chacun est jugé à intervalles réguliers.
 */
export class FairQueue<T, R> {
  private running = 0;
  private readonly pending = new Map<string, Pending<T, R>>();
  private readonly lastServed = new Map<string, number>();
  private served = 0;

  constructor(
    private readonly maxConcurrent: number,
    private readonly run: (item: T) => Promise<R>,
  ) {}

  /** Résolu avec le résultat de la tâche, ou null si une demande plus récente l'a remplacée. */
  submit(key: string, item: T): Promise<R | null> {
    return new Promise((resolve) => {
      this.pending.get(key)?.resolve(null);
      this.pending.set(key, { item, resolve });
      this.pump();
    });
  }

  private next(): string | undefined {
    let best: string | undefined;
    let bestServed = Infinity;
    for (const key of this.pending.keys()) {
      const served = this.lastServed.get(key) ?? -1;
      if (served < bestServed) {
        best = key;
        bestServed = served;
      }
    }
    return best;
  }

  private pump(): void {
    while (this.running < this.maxConcurrent) {
      const key = this.next();
      if (key === undefined) return;
      const task = this.pending.get(key);
      this.pending.delete(key);
      if (task === undefined) return;
      this.lastServed.set(key, this.served++);
      this.running++;
      this.run(task.item)
        .then(
          (result) => {
            task.resolve(result);
          },
          () => {
            task.resolve(null);
          },
        )
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }

  /** Le demandeur s'en va (relais fermé) : sa demande en attente et son historique sont oubliés. */
  forget(key: string): void {
    this.pending.get(key)?.resolve(null);
    this.pending.delete(key);
    this.lastServed.delete(key);
  }
}
