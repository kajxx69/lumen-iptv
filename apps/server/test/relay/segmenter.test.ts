import { describe, expect, it } from 'vitest';
import { type SegmentDraft, TsSegmenter, type SegmenterOptions } from '../../src/relay/segmenter.js';
import {
  AUDIO_FRAME_TICKS,
  AUDIO_PID,
  CLOCK,
  FRAME_TICKS,
  PACKET,
  PMT_PID,
  TsBuilder,
  VIDEO_PID,
  buildStream,
  ccOf,
  concat,
  nullPacket,
  pidOf,
  startsWithIdr,
  videoPts,
} from './ts-builder.js';

const OPTIONS: SegmenterOptions = {
  targetDurationS: 2,
  firstTargetDurationS: 1,
  forceCutDurationS: 5.5,
  timestampJumpS: 5,
  minFlushDurationS: 0.5,
  fastStartS: 0,
  partTargetS: 0,
};

function segment(
  input: Uint8Array | Uint8Array[],
  options: Partial<SegmenterOptions> = {},
): {
  out: SegmentDraft[];
  seg: TsSegmenter;
} {
  const out: SegmentDraft[] = [];
  const seg = new TsSegmenter({ ...OPTIONS, ...options }, (d) => out.push(d));
  for (const chunk of Array.isArray(input) ? input : [input]) seg.push(chunk);
  return { out, seg };
}

function chunked(buf: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let off = 0; off < buf.length; off += size) out.push(buf.subarray(off, off + size));
  return out;
}

const durations = (out: SegmentDraft[]): number[] => out.map((d) => Number(d.durationS.toFixed(3)));

describe('découpeur MPEG-TS', () => {
  it('coupe sur les images clés : PAT, PMT puis une image clé en tête de chaque segment', () => {
    const { out } = segment(buildStream({ durationS: 10 }));
    // Le dernier GOP [8 s, 10 s) attend l'image clé suivante pour être complet.
    expect(durations(out)).toEqual([2, 2, 2, 2]);
    for (const d of out) {
      expect(d.data.length % PACKET).toBe(0);
      expect(pidOf(d.data, 0)).toBe(0);
      expect(pidOf(d.data, 1)).toBe(PMT_PID);
      expect(startsWithIdr(d.data)).toBe(true);
      expect(d.independent).toBe(true);
      expect(d.discontinuity).toBe(false);
    }
    // Les horodatages s'enchaînent exactement d'un segment à l'autre.
    const firsts = out.map((d) => videoPts(d.data)[0]);
    expect(firsts).toEqual([900_000, 1_080_000, 1_260_000, 1_440_000]);
    // Chaque segment connaît l'horodatage de sa première image (recalage entre sorties).
    expect(out.map((d) => d.startTs)).toEqual(firsts);
  });

  it('résultat identique quel que soit le découpage réseau des octets', () => {
    const stream = buildStream({ durationS: 7 });
    const reference = segment(stream).out.map((d) => Buffer.from(d.data).toString('hex'));
    for (const size of [1, 7, 188, 1000, 65_536]) {
      expect(segment(chunked(stream, size)).out.map((d) => Buffer.from(d.data).toString('hex'))).toEqual(
        reference,
      );
    }
  });

  it('ignore tout ce qui précède la première image clé (indécodable)', () => {
    // Connexion au milieu d'un GOP : 1,2 s d'images différentielles avant la première clé.
    const { out } = segment(buildStream({ durationS: 7, startFrameInGop: 20 }));
    expect(out.length).toBeGreaterThan(0);
    expect(startsWithIdr(out[0]!.data)).toBe(true);
    expect(videoPts(out[0]!.data)[0]).toBe(900_000 + 30 * FRAME_TICKS);
  });

  it('reconnaît les images clés par l analyse H.264 quand l amont ne pose pas le drapeau RAI', () => {
    const { out } = segment(buildStream({ durationS: 10, rai: false }));
    expect(durations(out)).toEqual([2, 2, 2, 2]);
    for (const d of out) expect(startsWithIdr(d.data)).toBe(true);
  });

  it('premier segment court pour un démarrage rapide, puis la durée visée', () => {
    const { out } = segment(buildStream({ durationS: 8, gopS: 1 }));
    expect(durations(out)).toEqual([1, 2, 2, 2]);
  });

  it('GOP trop long : coupe forcée avant la durée maximale, segment marqué non autonome', () => {
    const { out, seg } = segment(buildStream({ durationS: 12, gopS: 20 }));
    expect(out.length).toBe(2);
    expect(out[0]!.independent).toBe(true);
    expect(out[1]!.independent).toBe(false);
    for (const d of out) expect(d.durationS).toBeLessThanOrEqual(OPTIONS.forceCutDurationS + 0.05);
    expect(seg.stats.forcedCuts).toBe(2);
  });

  it('saut d horodatage dans le flux : segment en cours émis, discontinuité sur le suivant', () => {
    const b = new TsBuilder();
    const before = buildStream({ durationS: 5, builder: b });
    const after = buildStream({ durationS: 5, startPts: 900_000 + 100 * CLOCK, builder: b });
    const { out, seg } = segment(concat([before, after]));
    expect(durations(out)).toEqual([2, 2, 1, 2, 2]);
    expect(out.map((d) => d.discontinuity)).toEqual([false, false, false, true, false]);
    expect(seg.stats.timestampJumps).toBe(1);
  });

  it('rupture de connexion : segment partiel conservé, discontinuité, nouveaux PID acceptés', () => {
    const { out, seg } = segment(buildStream({ durationS: 5.5 }));
    expect(durations(out)).toEqual([2, 2]);
    seg.breakStream();
    // Le morceau [4 s, 5,52 s) est utile : il est émis plutôt que perdu (dernière image
    // à 5,48 s, plus sa propre durée).
    expect(durations(out)).toEqual([2, 2, 1.52]);
    // Nouvelle source : autres PID, autres horodatages.
    const other = new TsBuilder({ video: true, audio: true }, { pmt: 0x20, video: 0x21, audio: 0x22 });
    seg.push(buildStream({ durationS: 5, startPts: 5_000_000, builder: other }));
    expect(out.length).toBe(5);
    expect(out[3]!.discontinuity).toBe(true);
    expect(out[4]!.discontinuity).toBe(false);
    expect(videoPts(out[3]!.data, 0x21)[0]).toBe(5_000_000);
    expect(pidOf(out[3]!.data, 1)).toBe(0x20);
    expect(out[3]!.durationS).toBe(2);
    expect(startsWithIdr(out[3]!.data, 0x21)).toBe(true);
  });

  it('rupture juste après une image clé : morceau trop court jeté, pas de segment minuscule', () => {
    const { out, seg } = segment(buildStream({ durationS: 4.2 }));
    expect(durations(out)).toEqual([2, 2]);
    seg.breakStream();
    expect(durations(out)).toEqual([2, 2]);
  });

  it('radio (audio seul) : découpe sur les trames audio', () => {
    const { out } = segment(buildStream({ durationS: 9, video: false }));
    expect(out.length).toBe(4);
    for (const d of out.slice(1)) {
      expect(d.durationS).toBeGreaterThanOrEqual(2);
      expect(d.durationS).toBeLessThan(2 + AUDIO_FRAME_TICKS / CLOCK);
    }
  });

  it('se resynchronise après des octets parasites', () => {
    const stream = buildStream({ durationS: 7 });
    const cut = 300 * PACKET;
    const garbage = Uint8Array.from([0x47, 1, 2, 3, 0x47, 0x47, 9, 9, 9]);
    const { out, seg } = segment(concat([stream.subarray(0, cut), garbage, stream.subarray(cut)]));
    expect(durations(out)).toEqual([2, 2, 2]);
    expect(seg.stats.resyncs).toBeGreaterThan(0);
  });

  it('gère le rebouclage des horodatages 33 bits', () => {
    const { out } = segment(buildStream({ durationS: 9, startPts: 2 ** 33 - 3 * CLOCK }));
    expect(durations(out)).toEqual([2, 2, 2, 2]);
  });

  it('retire le bourrage (paquets nuls) et ne duplique pas les PAT/PMT amont', () => {
    const stream = buildStream({ durationS: 5 });
    const padded: Uint8Array[] = [];
    for (let off = 0; off < stream.length; off += PACKET)
      padded.push(stream.subarray(off, off + PACKET), nullPacket());
    const { out } = segment(padded);
    for (const d of out) {
      const pids = Array.from({ length: d.data.length / PACKET }, (_, i) => pidOf(d.data, i));
      expect(pids.filter((p) => p === 0x1fff)).toHaveLength(0);
      expect(pids.filter((p) => p === 0)).toHaveLength(1);
      expect(pids.filter((p) => p === PMT_PID)).toHaveLength(1);
      expect(pids.filter((p) => p === VIDEO_PID).length).toBeGreaterThan(0);
      expect(pids.filter((p) => p === AUDIO_PID).length).toBeGreaterThan(0);
    }
  });

  it('compteurs de continuité des PAT/PMT ajoutées : continus d un segment à l autre', () => {
    const { out } = segment(buildStream({ durationS: 10 }));
    expect(out.map((d) => ccOf(d.data, 0))).toEqual([0, 1, 2, 3]);
    expect(out.map((d) => ccOf(d.data, 1))).toEqual([0, 1, 2, 3]);
  });

  describe('démarrage rapide (nouvelle source : données au lecteur sans attendre l image clé suivante)', () => {
    const FAST = { fastStartS: 2, firstTargetDurationS: 0.5 };

    it('segments courts pendant la phase de démarrage, puis coupe sur les images clés', () => {
      const { out } = segment(buildStream({ durationS: 6 }), FAST);
      // Coupe à la première image au-delà de 0,5 s (images de 40 ms), puis à l'image clé de 4 s.
      expect(durations(out)).toEqual([0.52, 0.52, 0.52, 2.44]);
      expect(out.map((d) => d.independent)).toEqual([true, false, false, false]);
      expect(startsWithIdr(out[0]!.data)).toBe(true);
    });

    it('chaque nouvelle source (bascule, reconnexion) repart en démarrage rapide', () => {
      const { out, seg } = segment(buildStream({ durationS: 6 }), FAST);
      seg.breakStream();
      const before = out.length;
      const other = new TsBuilder({ video: true, audio: true }, { pmt: 0x20, video: 0x21, audio: 0x22 });
      seg.push(buildStream({ durationS: 3, startPts: 5_000_000, builder: other }));
      const fresh = out.slice(before);
      expect(durations(fresh)).toEqual([0.52, 0.52, 0.52]);
      expect(fresh[0]!.discontinuity).toBe(true);
      expect(startsWithIdr(fresh[0]!.data, 0x21)).toBe(true);
    });
  });

  describe('parties de segment (LL-HLS)', () => {
    const LL = { partTargetS: 0.5 };
    const body = (data: Uint8Array): Uint8Array => data.subarray(2 * PACKET);

    it('chaque segment se découpe en parties de 0,5 s au plus, publiées avant lui', () => {
      const parts: number[] = [];
      const order: string[] = [];
      const seg = new TsSegmenter(
        { ...OPTIONS, ...LL },
        (d) => order.push(`segment ${d.durationS.toFixed(2)}`),
        (p) => {
          parts.push(Number(p.durationS.toFixed(2)));
          order.push('partie');
        },
      );
      seg.push(buildStream({ durationS: 4.5 }));
      // Images de 40 ms : une partie s'arrête avant de dépasser 0,5 s, soit 12 images (0,48 s).
      expect(parts.slice(0, 4)).toEqual([0.48, 0.48, 0.48, 0.48]);
      expect(Math.max(...parts)).toBeLessThanOrEqual(LL.partTargetS);
      expect(order.indexOf('segment 2.00')).toBeGreaterThan(order.indexOf('partie'));
    });

    it('les parties d un segment le reconstituent exactement, chacune décodable à la suite', () => {
      const { out } = segment(buildStream({ durationS: 4.5 }), LL);
      const first = out[0]!;
      expect(first.parts.length).toBeGreaterThan(1);
      for (const p of first.parts) {
        // PAT et PMT en tête de chaque partie : le lecteur peut commencer à n'importe laquelle.
        expect(pidOf(p.data, 0)).toBe(0);
        expect(pidOf(p.data, 1)).toBe(PMT_PID);
      }
      expect(Buffer.concat(first.parts.map((p) => body(p.data)))).toEqual(Buffer.from(body(first.data)));
      expect(first.parts.reduce((t, p) => t + p.durationS, 0)).toBeCloseTo(first.durationS, 5);
      expect(first.parts.map((p) => p.independent)).toEqual([true, ...first.parts.slice(1).map(() => false)]);
      // Compteurs de continuité des tables propres aux parties : continus d'une partie à l'autre.
      const all = out.flatMap((d) => d.parts);
      expect(all.map((p) => ccOf(p.data, 0))).toEqual(all.map((_, i) => i % 16));
    });

    it('sans cible de partie : aucune partie (lecture confort)', () => {
      const { out } = segment(buildStream({ durationS: 4.5 }));
      expect(out.every((d) => d.parts.length === 0)).toBe(true);
    });

    it('une rupture garde les parties déjà annoncées : leur segment est publié, même court', () => {
      const { out, seg } = segment(buildStream({ durationS: 4.6 }), { ...LL, minFlushDurationS: 1 });
      seg.breakStream();
      const last = out.at(-1)!;
      expect(last.durationS).toBeCloseTo(0.6, 2);
      expect(last.parts.length).toBeGreaterThan(0);
    });
  });

  it('rien n est émis tant que PAT et PMT sont inconnues', () => {
    const stream = buildStream({ durationS: 5, psiEveryFrames: 1000 });
    // Sans les quatre premiers paquets (PAT, PMT d'ouverture puis de la première image),
    // aucune table n'arrive jamais.
    const { out } = segment(stream.subarray(4 * PACKET));
    expect(out).toHaveLength(0);
  });
});
