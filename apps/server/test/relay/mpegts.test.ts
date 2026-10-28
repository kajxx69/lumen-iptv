import { describe, expect, it } from 'vitest';
import { parsePmt } from '../../src/relay/mpegts.js';

/** PMT tenant dans un paquet, avec les flux élémentaires donnés (type, PID, descripteurs). */
function pmtPacket(streams: { type: number; pid: number; descriptors?: number[] }[]): Uint8Array {
  const es: number[] = [];
  for (const s of streams) {
    const d = s.descriptors ?? [];
    es.push(s.type, 0xe0 | (s.pid >> 8), s.pid & 0xff, 0xf0 | (d.length >> 8), d.length & 0xff, ...d);
  }
  const length = 9 + es.length + 4;
  const section = [
    0x02,
    0xb0 | (length >> 8),
    length & 0xff,
    0x00,
    0x01,
    0xc1,
    0x00,
    0x00,
    0xe1,
    0x00,
    0xf0,
    0x00,
    ...es,
  ];
  const packet = new Uint8Array(188).fill(0xff);
  packet.set([0x47, 0x40 | 0x10, 0x00, 0x10, 0x00, ...section, 0, 0, 0, 0]);
  return packet;
}

describe('PMT : codecs des flux', () => {
  it('H.264 + AAC', () => {
    const p = parsePmt(
      pmtPacket([
        { type: 0x1b, pid: 0x100 },
        { type: 0x0f, pid: 0x101 },
      ]),
      0,
    );
    expect(p).toMatchObject({ videoPid: 0x100, videoCodec: 'h264', audioPids: [0x101], audioCodec: 'aac' });
  });

  it('MPEG-2 + MPEG audio (DVB classique)', () => {
    const p = parsePmt(
      pmtPacket([
        { type: 0x02, pid: 0x100 },
        { type: 0x04, pid: 0x101 },
      ]),
      0,
    );
    expect(p).toMatchObject({ videoCodec: 'mpeg2', audioCodec: 'mp3' });
  });

  it('HEVC + AC-3 (type ATSC 0x81)', () => {
    const p = parsePmt(
      pmtPacket([
        { type: 0x24, pid: 0x100 },
        { type: 0x81, pid: 0x101 },
      ]),
      0,
    );
    expect(p).toMatchObject({ videoCodec: 'hevc', audioCodec: 'ac3' });
  });

  it('AC-3 et E-AC-3 en flux privé DVB (0x06), reconnus à leur descripteur', () => {
    const ac3 = parsePmt(
      pmtPacket([
        { type: 0x1b, pid: 0x100 },
        { type: 0x06, pid: 0x101, descriptors: [0x6a, 1, 0x00] },
      ]),
      0,
    );
    expect(ac3).toMatchObject({ audioPids: [0x101], audioCodec: 'ac3' });
    const eac3 = parsePmt(
      pmtPacket([
        { type: 0x1b, pid: 0x100 },
        { type: 0x06, pid: 0x101, descriptors: [0x7a, 1, 0x00] },
      ]),
      0,
    );
    expect(eac3).toMatchObject({ audioCodec: 'eac3' });
  });

  it('flux privé sans descripteur audio (télétexte, sous-titres) : ignoré', () => {
    const p = parsePmt(
      pmtPacket([
        { type: 0x1b, pid: 0x100 },
        { type: 0x06, pid: 0x102, descriptors: [0x56, 1, 0x00] },
      ]),
      0,
    );
    expect(p).toMatchObject({ audioPids: [], audioCodec: null });
  });

  it('AAC LATM : codec à part, que les navigateurs ne lisent pas', () => {
    const p = parsePmt(
      pmtPacket([
        { type: 0x1b, pid: 0x100 },
        { type: 0x11, pid: 0x101 },
      ]),
      0,
    );
    expect(p).toMatchObject({ audioCodec: 'other' });
  });
});
