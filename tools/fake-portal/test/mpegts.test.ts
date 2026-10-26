import { describe, expect, it } from 'vitest';
import {
  ContinuityRewriter,
  TIMESTAMP_MODULO,
  TS_PACKET_SIZE,
  readHeader,
  readPcrBase,
  readTimestamp,
  timestampDelta,
  wrap33,
  writePcrBase,
  writeTimestamp,
} from '../src/media/mpegts.js';

function packet(pid: number, cc: number, withPayload = true): Buffer {
  const buf = Buffer.alloc(TS_PACKET_SIZE, 0xff);
  buf[0] = 0x47;
  buf[1] = (pid >> 8) & 0x1f;
  buf[2] = pid & 0xff;
  buf[3] = ((withPayload ? 0b01 : 0b10) << 4) | cc;
  if (!withPayload) buf[4] = 183;
  return buf;
}

describe('horodatages 33 bits', () => {
  it.each([0, 1, 90_000, 2 ** 30 - 1, 2 ** 30, 2 ** 32 + 12_345, TIMESTAMP_MODULO - 1])(
    'PTS %d aller-retour',
    (value) => {
      const buf = Buffer.from([0x21, 0, 0, 0, 0]);
      writeTimestamp(buf, 0, value);
      expect(readTimestamp(buf, 0)).toBe(value);
      // Le préfixe ('0010' pour un PTS seul) et les bits marqueurs sont préservés.
      expect(buf[0]! >> 4).toBe(0x2);
      expect(buf[0]! & 1).toBe(1);
      expect(buf[2]! & 1).toBe(1);
      expect(buf[4]! & 1).toBe(1);
    },
  );

  it('replie les valeurs hors plage', () => {
    expect(wrap33(TIMESTAMP_MODULO + 5)).toBe(5);
    expect(wrap33(-1)).toBe(TIMESTAMP_MODULO - 1);
    const buf = Buffer.alloc(5);
    writeTimestamp(buf, 0, -90_000);
    expect(readTimestamp(buf, 0)).toBe(TIMESTAMP_MODULO - 90_000);
  });

  it('calcule un écart signé à travers le rebouclage', () => {
    expect(timestampDelta(TIMESTAMP_MODULO - 1000, 2600)).toBe(3600);
    expect(timestampDelta(2600, TIMESTAMP_MODULO - 1000)).toBe(-3600);
  });

  it('base PCR aller-retour, extension préservée', () => {
    const buf = Buffer.from([0, 0, 0, 0, 0x7e | 0x01, 0x23]);
    for (const value of [0, 123_456_789, TIMESTAMP_MODULO - 1]) {
      writePcrBase(buf, 0, value);
      expect(readPcrBase(buf, 0)).toBe(value);
      expect(buf[4]! & 0x7f).toBe(0x7f);
      expect(buf[5]).toBe(0x23);
    }
  });
});

describe('ContinuityRewriter', () => {
  it('rend les compteurs continus par PID à travers des segments disjoints', () => {
    const rewriter = new ContinuityRewriter();
    const first = Buffer.concat([packet(0x100, 7), packet(0x100, 8), packet(0x101, 3)]);
    // Second segment : compteurs repartis de zéro, comme au rebouclage de la mire.
    const second = Buffer.concat([packet(0x100, 0), packet(0x100, 0, false), packet(0x101, 0)]);
    rewriter.rewrite(first);
    rewriter.rewrite(second);
    const cc = (buf: Buffer, i: number): number => readHeader(buf, i * TS_PACKET_SIZE).continuityCounter;
    expect([cc(first, 0), cc(first, 1), cc(first, 2)]).toEqual([7, 8, 3]);
    // Paquet sans charge utile : répète le dernier compteur.
    expect([cc(second, 0), cc(second, 1), cc(second, 2)]).toEqual([9, 9, 4]);
  });
});
