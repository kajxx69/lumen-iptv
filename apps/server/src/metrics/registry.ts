/**
 * Registre de métriques au format d'exposition Prometheus (texte 0.0.4). Volontairement
 * minimal : compteurs, jauges, histogrammes, sans dépendance. Aucune étiquette ne porte
 * d'identifiant de portail, de chaîne ou d'utilisateur.
 */

type Labels = Record<string, string>;

interface Metric {
  render(): string[];
}

const labelKey = (labels: Labels): string =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}="${(labels[k] ?? '').replace(/["\\\n]/g, '_')}"`)
    .join(',');

const formatSample = (name: string, key: string, value: number): string =>
  `${name}${key === '' ? '' : `{${key}}`} ${Number.isFinite(value) ? value : 0}`;

export class Counter implements Metric {
  private readonly values = new Map<string, number>();

  constructor(
    readonly name: string,
    private readonly help: string,
  ) {}

  inc(labels: Labels = {}, by = 1): void {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  value(labels: Labels = {}): number {
    return this.values.get(labelKey(labels)) ?? 0;
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.values.size === 0) lines.push(formatSample(this.name, '', 0));
    for (const [key, v] of this.values) lines.push(formatSample(this.name, key, v));
    return lines;
  }
}

/**
 * Valeur lue au moment de la collecte : toujours exacte, rien à tenir à jour. Jauge, ou
 * compteur tenu ailleurs (temps CPU du processus).
 */
export class Gauge implements Metric {
  constructor(
    readonly name: string,
    private readonly help: string,
    private readonly read: () => number,
    private readonly type: 'gauge' | 'counter' = 'gauge',
  ) {}

  render(): string[] {
    return [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} ${this.type}`,
      formatSample(this.name, '', this.read()),
    ];
  }
}

export class Histogram implements Metric {
  private readonly counts: number[];
  private sum = 0;
  private count = 0;

  constructor(
    readonly name: string,
    private readonly help: string,
    private readonly buckets: readonly number[],
  ) {
    this.counts = buckets.map(() => 0);
  }

  observe(value: number): void {
    this.sum += value;
    this.count++;
    this.buckets.forEach((le, i) => {
      if (value <= le) this.counts[i] = (this.counts[i] ?? 0) + 1;
    });
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    this.buckets.forEach((le, i) =>
      lines.push(formatSample(`${this.name}_bucket`, `le="${le}"`, this.counts[i] ?? 0)),
    );
    lines.push(formatSample(`${this.name}_bucket`, 'le="+Inf"', this.count));
    lines.push(
      formatSample(`${this.name}_sum`, '', this.sum),
      formatSample(`${this.name}_count`, '', this.count),
    );
    return lines;
  }
}

export class MetricsRegistry {
  private readonly metrics: Metric[] = [];

  counter(name: string, help: string): Counter {
    return this.add(new Counter(name, help));
  }

  gauge(name: string, help: string, read: () => number): Gauge {
    return this.add(new Gauge(name, help, read));
  }

  /** Compteur dont la valeur vient d'ailleurs (lu à la collecte). */
  counterFrom(name: string, help: string, read: () => number): Gauge {
    return this.add(new Gauge(name, help, read, 'counter'));
  }

  histogram(name: string, help: string, buckets: readonly number[]): Histogram {
    return this.add(new Histogram(name, help, buckets));
  }

  render(): string {
    return `${this.metrics.flatMap((m) => m.render()).join('\n')}\n`;
  }

  private add<M extends Metric>(metric: M): M {
    this.metrics.push(metric);
    return metric;
  }
}
