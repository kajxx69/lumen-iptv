import { useState } from 'react';

/** Initiales affichées quand le logo manque ou ne se charge pas (10 à 15 % des chaînes). */
function initials(name: string): string {
  const words = name
    .replace(/^\W*[A-Z]{2,3}\s*[|:]\s*/, '')
    .split(/\s+/)
    .filter((w) => w !== '');
  return words
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase();
}

/** Logo chargé paresseusement (seulement à l'approche de l'écran), avec repli. */
export function ChannelLogo({ src, name }: { src: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  if (src === null || failed) {
    return (
      <span className="logo-fallback" aria-hidden="true">
        {initials(name)}
      </span>
    );
  }
  return (
    <img
      className="logo"
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => {
        setFailed(true);
      }}
    />
  );
}
