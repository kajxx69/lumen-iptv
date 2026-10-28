import { describe, expect, it } from 'vitest';
import {
  MERGE_SOLO,
  type MergeEntry,
  fingerprintName,
  mergeChannels,
  pairKey,
  refKey,
} from '../../catalog/index.js';

const e = (portalId: string, channelId: string, name: string, epgId: string | null = null): MergeEntry => ({
  portalId,
  channelId,
  name,
  epgId,
});

const shape = (groups: { key: string; members: MergeEntry[] }[]) =>
  groups.map((g) => ({ key: g.key, members: g.members.map((m) => refKey(m)) }));

describe('fusion multi-portails', () => {
  it('même identifiant EPG sur deux portails : une seule chaîne, deux sources', () => {
    const groups = mergeChannels([
      e('A', '1', 'FR | NOVA TV FHD', 'nova.fr'),
      e('B', '9', 'Nova Télévision', 'nova.fr'),
    ]);
    expect(shape(groups)).toEqual([{ key: 'e:nova.fr', members: ['A:1', 'B:9'] }]);
  });

  it('même nom normalisé, sans identifiant EPG : rapprochées', () => {
    const groups = mergeChannels([e('A', '1', 'FR | NOVA TV FHD'), e('B', '9', 'Nova TV France 1080')]);
    expect(shape(groups)).toEqual([{ key: 'n:nova tv', members: ['A:1', 'B:9'] }]);
  });

  it('variantes de qualité sur un même portail : sources de secours l une de l autre', () => {
    const groups = mergeChannels([e('A', '1', 'FR | NOVA TV FHD'), e('A', '2', 'FR | NOVA TV SD')]);
    expect(groups).toHaveLength(1);
  });

  it('noms et identifiants différents : chaînes distinctes, dans l ordre d arrivée', () => {
    const groups = mergeChannels([e('A', '1', 'Nova TV', 'nova.fr'), e('B', '9', 'Sun Info', 'sun.fr')]);
    expect(shape(groups)).toEqual([
      { key: 'e:nova.fr', members: ['A:1'] },
      { key: 'e:sun.fr', members: ['B:9'] },
    ]);
  });

  it('grille EPG différente : le rapprochement est refusé, même identifiant EPG compris', () => {
    const a = e('A', '1', 'Nova TV', 'nova.fr');
    const b = e('B', '9', 'Nova TV', 'nova.fr');
    const groups = mergeChannels([a, b], { verdicts: new Map([[pairKey(a, b), 'different']]) });
    expect(groups).toHaveLength(2);
    // Clés distinctes : chaque chaîne reste adressable.
    expect(new Set(groups.map((g) => g.key)).size).toBe(2);
  });

  it('le refus tient aussi par transitivité (A~B par EPG, B~C par nom, A≠C)', () => {
    const a = e('A', '1', 'Nova TV', 'nova.fr');
    const b = e('B', '9', 'Nova', 'nova.fr');
    const c = e('C', '5', 'Nova');
    const groups = mergeChannels([a, b, c], { verdicts: new Map([[pairKey(a, c), 'different']]) });
    expect(shape(groups)).toEqual([
      { key: 'e:nova.fr', members: ['A:1', 'B:9'] },
      { key: 'n:nova', members: ['C:5'] },
    ]);
  });

  it('correction manuelle : une chaîne séparée de son groupe', () => {
    const a = e('A', '1', 'Nova TV', 'nova.fr');
    const b = e('B', '9', 'Nova TV', 'nova.fr');
    const groups = mergeChannels([a, b], { overrides: new Map([[refKey(b), MERGE_SOLO]]) });
    expect(shape(groups)).toEqual([
      { key: 'e:nova.fr', members: ['A:1'] },
      { key: 's:B:9', members: ['B:9'] },
    ]);
  });

  it('correction manuelle : une chaîne rattachée à un groupe malgré un nom sans rapport', () => {
    const a = e('A', '1', 'CANAL+ FHD', 'canalplus.fr');
    const b = e('B', '9', 'C+ 1080');
    const groups = mergeChannels([a, b], { overrides: new Map([[refKey(b), 'e:canalplus.fr']]) });
    expect(shape(groups)).toEqual([{ key: 'e:canalplus.fr', members: ['A:1', 'B:9'] }]);
  });

  it('la clé d un groupe ne dépend pas de l ordre des portails', () => {
    const a = e('A', '1', 'Nova TV', 'nova.fr');
    const b = e('B', '9', 'Nova TV');
    expect(mergeChannels([a, b])[0]!.key).toBe(mergeChannels([b, a])[0]!.key);
  });

  it('100 000 entrées sur 3 portails, empreintes calculées à la synchronisation : fusion en moins d une seconde', () => {
    const entries: MergeEntry[] = [];
    for (const portal of ['A', 'B', 'C']) {
      for (let i = 0; i < 33_334; i++) {
        const entry = e(portal, String(i), `FR | Chaîne C${i} HD`, i % 3 === 0 ? `ch${i}.fr` : null);
        entries.push({ ...entry, fingerprint: fingerprintName(entry.name) });
      }
    }
    // Meilleur de trois passages : la machine de test fait tourner d'autres suites en parallèle.
    let best = Infinity;
    let groups: ReturnType<typeof mergeChannels> = [];
    for (let run = 0; run < 3; run++) {
      const t0 = performance.now();
      groups = mergeChannels(entries);
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(1000);
    expect(groups).toHaveLength(33_334);
  });
});
