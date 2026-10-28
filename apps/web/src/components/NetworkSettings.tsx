import type { QualityProfile } from '@lumen/protocol';
import { useState } from 'react';
import { dataUsage, formatBytes } from '../player/data-usage.js';
import { QUALITY_LABEL, QUALITY_ORDER } from '../player/quality.js';
import { useNetwork } from '../player/use-network.js';
import { usePrefs } from '../state/prefs.js';

const NETWORK_LABEL = { wifi: 'WiFi', cellular: 'données mobiles', unknown: 'réseau inconnu' } as const;

/**
 * Réseau et données (PROJECT.md, adaptation au réseau) : qualité maximale par réseau,
 * économie de données, consommation de cet appareil. Réglages propres à l'appareil.
 */
export function NetworkSettings() {
  const prefs = usePrefs((s) => s.quality);
  const setPrefs = usePrefs((s) => s.setQualityPrefs);
  const network = useNetwork();
  const [used, setUsed] = useState(() => dataUsage.bytes());

  const select = (label: string, value: QualityProfile, onChange: (q: QualityProfile) => void) => (
    <label className="field">
      <span>{label}</span>
      <select
        data-nav
        value={value}
        onChange={(e) => {
          const q = QUALITY_ORDER.find((x) => x === e.target.value);
          if (q !== undefined) onChange(q);
        }}
      >
        {QUALITY_ORDER.map((q) => (
          <option key={q} value={q}>
            {QUALITY_LABEL[q]}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <section className="form" aria-labelledby="network-title">
      <h2 id="network-title">Réseau et données</h2>
      <p className="programme-now">
        Réseau actuel : {NETWORK_LABEL[network.kind]}
        {network.slow ? ' (lent : tampon renforcé)' : ''}. La qualité descend toute seule si le débit ne suit
        pas, et remonte quand il le permet, sans jamais dépasser ces plafonds.
      </p>
      {select('Qualité maximale en WiFi', prefs.wifi, (q) => {
        // Réseau inconnu (navigateur muet sur le réseau) : traité comme le WiFi.
        setPrefs({ wifi: q, unknown: q });
      })}
      {select('Qualité maximale en données mobiles', prefs.cellular, (q) => {
        setPrefs({ cellular: q });
      })}
      <button
        type="button"
        className={`button${prefs.dataSaver ? ' primary' : ''}`}
        data-nav
        aria-pressed={prefs.dataSaver}
        onClick={() => {
          setPrefs({ dataSaver: !prefs.dataSaver });
        }}
      >
        Économie de données {prefs.dataSaver ? 'activée' : 'désactivée'}
      </button>
      <p className="programme-now" data-testid="data-usage">
        Consommé ce mois-ci sur cet appareil : {formatBytes(used)}
        {network.saveData ? ' · économie de données demandée par le système' : ''}
      </p>
      <button
        type="button"
        className="button"
        data-nav
        onClick={() => {
          dataUsage.reset();
          setUsed(0);
        }}
      >
        Remettre le compteur à zéro
      </button>
    </section>
  );
}
