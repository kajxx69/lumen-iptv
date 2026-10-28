import { useEffect, useState } from 'react';
import { type NetworkInfo, currentNetwork, onNetworkChange } from './network.js';

/** Réseau de l'appareil, tenu à jour (passage du WiFi aux données mobiles, retour en ligne). */
export function useNetwork(): NetworkInfo {
  const [network, setNetwork] = useState(currentNetwork);
  useEffect(
    () =>
      onNetworkChange(() => {
        setNetwork(currentNetwork());
      }),
    [],
  );
  return network;
}
