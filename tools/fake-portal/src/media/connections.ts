import type { ServerResponse } from 'node:http';
import type { ChaosController } from '../chaos/controller.js';
import { sleep } from '../clock.js';

/**
 * Taille d'un envoi sous étranglement. 4 Kio à 200 kbit/s ≈ 160 ms entre envois :
 * assez fin pour que le débit mesuré côté client soit régulier.
 */
const THROTTLE_SLICE_BYTES = 4096;

interface ActiveStream {
  channelId: string;
  response: ServerResponse;
}

/** Connexions de flux ouvertes, pour les couper sur `drop` ou `expire-token`. */
export class StreamConnections {
  private nextId = 1;
  private readonly active = new Map<number, ActiveStream>();

  add(channelId: string, response: ServerResponse): number {
    const id = this.nextId++;
    this.active.set(id, { channelId, response });
    response.on('close', () => this.active.delete(id));
    return id;
  }

  /** Coupe brutalement les sockets : le client voit une connexion réinitialisée. */
  kill(channelId: string | null): number {
    let killed = 0;
    for (const [id, stream] of this.active) {
      if (channelId === null || stream.channelId === channelId) {
        stream.response.destroy();
        this.active.delete(id);
        killed++;
      }
    }
    return killed;
  }

  countByChannel(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const { channelId } of this.active.values()) counts[channelId] = (counts[channelId] ?? 0) + 1;
    return counts;
  }
}

function waitDrain(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

/** Écrit en respectant la contre-pression et, s'il est actif, l'étranglement de débit. */
export async function writeOut(res: ServerResponse, buf: Buffer, chaos: ChaosController): Promise<void> {
  let offset = 0;
  while (offset < buf.length && !res.destroyed) {
    // Relu à chaque tranche : un étranglement déclenché en cours d'envoi s'applique aussitôt.
    const kbps = chaos.throttleKbps;
    const end = kbps === null ? buf.length : Math.min(buf.length, offset + THROTTLE_SLICE_BYTES);
    const slice = buf.subarray(offset, end);
    offset = end;
    if (!res.write(slice)) await waitDrain(res);
    // kbit/s = bits par milliseconde.
    if (kbps !== null) await sleep((slice.length * 8) / kbps);
  }
}
