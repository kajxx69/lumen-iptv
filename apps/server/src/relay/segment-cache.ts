/**
 * Segments sortis des tampons glissants, gardés tant qu'il reste de la place : un
 * lecteur en retard (réseau lent, retour arrière) les obtient sans repasser par l'amont.
 * Une seule enveloppe en octets pour tous les relais, le moins récemment lu part en premier.
 */
export class SegmentCache {
  private readonly entries = new Map<string, Buffer>();
  private size = 0;

  constructor(private readonly maxBytes: number) {}

  put(relayId: string, seq: number, data: Buffer): void {
    if (data.length > this.maxBytes) return;
    const key = cacheKey(relayId, seq);
    this.remove(key);
    this.entries.set(key, data);
    this.size += data.length;
    for (const [oldest, buf] of this.entries) {
      if (this.size <= this.maxBytes) break;
      this.entries.delete(oldest);
      this.size -= buf.length;
    }
  }

  get(relayId: string, seq: number): Buffer | undefined {
    const key = cacheKey(relayId, seq);
    const data = this.entries.get(key);
    if (data === undefined) return undefined;
    // Réinsertion : la Map garde l'ordre d'insertion, la fin est donc le plus récent.
    this.entries.delete(key);
    this.entries.set(key, data);
    return data;
  }

  forget(relayId: string): void {
    const prefix = `${relayId}/`;
    for (const key of [...this.entries.keys()]) if (key.startsWith(prefix)) this.remove(key);
  }

  get bytes(): number {
    return this.size;
  }

  private remove(key: string): void {
    const data = this.entries.get(key);
    if (data === undefined) return;
    this.entries.delete(key);
    this.size -= data.length;
  }
}

const cacheKey = (relayId: string, seq: number): string => `${relayId}/${seq}`;
