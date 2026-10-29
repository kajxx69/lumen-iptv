import { describe, expect, it } from 'vitest';
import { WebVttStream, activeCue, parseSubtitles, parseTime } from '../subtitles/index.js';

const SRT = `${String.fromCharCode(0xfeff)}1\r
00:00:01,000 --> 00:00:03,500\r
<i>Bonjour</i> à tous\r
\r
2\r
00:01:05,250 --> 00:01:07,000\r
{\\an8}Deuxième\\Nligne\r
`;

const VTT = `WEBVTT

NOTE un commentaire

00:01.000 --> 00:03.000 align:center
Première

1:00:00.000 --> 1:00:02.000
Une heure plus tard
`;

describe('sous-titres texte', () => {
  it('horodatages WebVTT et SRT', () => {
    expect(parseTime('00:01.500')).toBe(1.5);
    expect(parseTime('01:02:03,456')).toBeCloseTo(3723.456, 3);
    expect(parseTime('1:00:00.000')).toBe(3600);
    expect(parseTime('n/a')).toBeNull();
  });

  it('SRT (fins de ligne Windows, BOM, balises) → répliques en texte seul', () => {
    expect(parseSubtitles(SRT)).toEqual([
      { startS: 1, endS: 3.5, text: 'Bonjour à tous' },
      { startS: 65.25, endS: 67, text: 'Deuxième\nligne' },
    ]);
  });

  it('WebVTT : en-tête, notes et réglages de placement ignorés', () => {
    expect(parseSubtitles(VTT)).toEqual([
      { startS: 1, endS: 3, text: 'Première' },
      { startS: 3600, endS: 3602, text: 'Une heure plus tard' },
    ]);
  });

  it('au fil de l eau : chaque réplique dès que son bloc est complet', () => {
    const stream = new WebVttStream();
    expect(stream.push('WEBVTT\n\n00:01.000 --> 00:02')).toEqual([]);
    expect(stream.push('.000\nUn\n\n00:03.000 --> 00:04.000\nDe')).toEqual([
      { startS: 1, endS: 2, text: 'Un' },
    ]);
    expect(stream.push('ux\n')).toEqual([]);
    expect(stream.flush()).toEqual([{ startS: 3, endS: 4, text: 'Deux' }]);
  });

  it('réplique affichée à un instant donné', () => {
    const cues = parseSubtitles(VTT);
    expect(activeCue(cues, 0.5)).toBeNull();
    expect(activeCue(cues, 2)?.text).toBe('Première');
    expect(activeCue(cues, 3)).toBeNull();
    expect(activeCue(cues, 3601)?.text).toBe('Une heure plus tard');
  });
});
