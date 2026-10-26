# Lumen

Lecteur IPTV (Stalker Portal) centré sur la résilience. Voir [PROJECT.md](PROJECT.md) pour la spécification.

**État : phase 0** — monorepo, outillage, portail Stalker factice et API de chaos.

## Prérequis

| Outil            | Version                                   | Rôle                                         |
| ---------------- | ----------------------------------------- | -------------------------------------------- |
| Node.js          | 22 LTS                                    | exécution, tests                             |
| pnpm             | 10 (`npm i -g pnpm` ou `corepack enable`) | monorepo                                     |
| FFmpeg           | ≥ 5 avec libx264                          | génération des mires, analyse dans les tests |
| Docker + Compose | optionnel                                 | lancer le faux portail en conteneur          |

FFmpeg doit être dans le `PATH`, ou désigné par `FFMPEG_PATH`. Les tests échouent explicitement
(`FFMPEG_NOT_FOUND`) s'il manque.

## Démarrage rapide

```sh
pnpm install
pnpm fake-portal          # portail factice sur http://localhost:8080
pnpm test                 # tests Vitest (unitaires + chaos)
pnpm test:e2e             # test Playwright (lance son propre portail sur le port 18080)
pnpm check                # typecheck + lint + format + tests
```

Au premier lancement, le portail génère avec FFmpeg deux boucles de 64 s (mire et écran noir)
dans `tools/fake-portal/.cache/assets` (20 à 60 s selon la machine). Elles sont ensuite réutilisées.

Avec Docker :

```sh
docker compose up --build                  # un portail sur :8080
docker compose --profile multi up --build  # + un second portail (:8081), même chaînes, autres noms
```

## Arborescence

```
packages/core/{stalker,sources,catalog,resilience}   logique métier pure (vides en phase 0)
packages/protocol                                    schémas partagés (vide en phase 0)
apps/server, apps/web                                backend et client (vides en phase 0)
tools/fake-portal                                    portail Stalker factice + chaos
docker/                                              images
```

`packages/core` est interdit d'import `node:*` et de `fetch`/`window`/`process` globaux par ESLint.

## Le portail factice

### Protocole

Points d'entrée (configurables) : `/stalker_portal/server/load.php`, `/server/load.php`,
`/portal.php`, `/c/portal.php`.

Le portail exige les en-têtes MAG (`Cookie: mac=…`, `User-Agent` contenant `MAG…`,
`X-User-Agent: Model: MAG250`), puis `Authorization: Bearer <token>` après le handshake.

| Domaine        | Actions                                                                                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stb`          | `handshake`, `get_profile`, `do_auth`, `get_account_info`, `get_localization`, `log`                                                                                          |
| `account_info` | `get_main_info`, `get_account_info`                                                                                                                                           |
| `watchdog`     | `get_events`                                                                                                                                                                  |
| `itv`          | `get_genres`, `get_all_channels`, `get_ordered_list`, `create_link`, `get_link`, `get_short_epg`, `get_epg_info`, `get_data_table`, `get_fav_ids`, `get_fav_items`, `set_fav` |
| `epg`          | `get_data_table`, `get_simple_data_table`                                                                                                                                     |
| `vod`          | `get_categories`, `get_ordered_list` (avec `search`), `create_link`                                                                                                           |
| `series`       | `get_categories`, `get_ordered_list` (séries → `movie_id` saisons → `season_id` épisodes), `create_link`                                                                      |
| `radio`        | `get_genres`, `get_categories`, `get_ordered_list`, `create_link`                                                                                                             |
| `tv_archive`   | `create_link` (cmd horodaté `auto /media/<ch>_<début>_<durée>.mpg`)                                                                                                           |

Comportements réalistes reproduits :

- 5 000 chaînes, 13 genres, 1 500 films, 300 séries, 200 radios, EPG généré à la demande.
- Nombres renvoyés en chaînes (`stringNumbers`), pagination par 14, `total_items`.
- `create_link` renvoie une URL préfixée par `ffmpeg `, `auto ` ou rien selon la chaîne.
- Liens éphémères : à ouvrir sous 30 s, flux TS à usage unique (une reconnexion exige un
  nouveau `create_link`), HLS réutilisable tant que la session vit.
- Session expirée après 1 h d'inactivité ; `get_profile` la maintient.
- Bannissement de la MAC au-delà de 20 requêtes/s (HTTP 429 pendant 60 s).
- Logos absents (10 %) ou cassés (5 %), `xmltv_id` parfois vide.
- `do_auth` exigé si `FAKE_PORTAL_REQUIRE_DO_AUTH=true` (`get_profile` renvoie alors `status=2`).

Les flux sont une mire FFmpeg (`testsrc`, compteur incrusté, bip à 1 kHz chaque seconde) :
un gel se voit et s'entend. Formats :

- `/play/live.php?…&extension=ts` : MPEG-TS continu, cadencé en temps réel par tranches de 200 ms ;
- `/play/live.php?…&extension=m3u8` : HLS live, fenêtre de 6 segments de 2 s ;
- `/play/movie.php` : VOD (requêtes `Range`) ; `/play/archive.php` : archive.

Toutes les chaînes partagent une horloge : le PTS d'une image est une fonction affine de
l'instant où elle est produite. Les tests peuvent donc relier un PTS reçu à l'heure murale.

### API de chaos

| Requête                                                            | Effet                                                                                                            |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `POST /_chaos/latency {ms, scope:"api"\|"stream"}`                 | retard avant chaque réponse API, ou avant le premier octet de chaque requête de flux                             |
| `POST /_chaos/drop {durationMs, channelId?}`                       | sockets des flux coupées, reconnexions réinitialisées pendant la fenêtre ; sans `channelId` : toutes les chaînes |
| `POST /_chaos/expire-token {killStreams?=true}`                    | tous les tokens et liens invalidés (401 sur l'API), flux en cours coupés                                         |
| `POST /_chaos/http-error {code, probability, scope?="all", seed?}` | code injecté à la place de la réponse, tirage reproductible                                                      |
| `POST /_chaos/throttle {bitrateKbps}`                              | débit sortant des flux plafonné                                                                                  |
| `POST /_chaos/corrupt {segmentProbability, seed?}`                 | segments tirés : 5 % des paquets TS ont leur charge utile brouillée (en-têtes intacts)                           |
| `POST /_chaos/freeze {durationMs, channelId?}`                     | **octets envoyés, PTS/DTS figés** ; le PCR continue d'avancer                                                    |
| `POST /_chaos/blackscreen {durationMs, channelId?}`                | image noire et silence, horodatages continus, même débit                                                         |
| `POST /_chaos/reset`                                               | retour à l'état nominal (et levée des bannissements)                                                             |
| `GET /_chaos/state`                                                | pannes actives et nombre de connexions de flux par chaîne                                                        |

Granularité : `freeze` s'applique image par image ; `blackscreen` et `corrupt` par segment de
2 s (on ne peut pas couper un GOP). L'API de chaos se désactive avec `FAKE_PORTAL_CHAOS_ENABLED=false`.

### Configuration

Toutes les valeurs sont dans [tools/fake-portal/src/config.ts](tools/fake-portal/src/config.ts),
documentées, surchargeables par `FAKE_PORTAL_*` : `PORT`, `HOST`, `SEED`, `NAMING_STYLE`
(`pipe`/`plain`), `CHANNEL_COUNT`, `ENTRYPOINTS` (liste séparée par des virgules),
`REQUIRE_DO_AUTH`, `STREAM_FORMAT` (`ts`/`m3u8`), `LINK_PREFIX_MODE`, `STRING_NUMBERS`,
`API_RATE_LIMIT_PER_SECOND`, `PLAY_TOKEN_TTL_MS`, `LOG_LEVEL`, etc.

## Tests

| Fichier                 | Couvre                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `mpegts.test.ts`        | lecture/écriture PTS, DTS, PCR 33 bits, compteurs de continuité                                                            |
| `renderer.test.ts`      | continuité des PTS au rebouclage, flux décodable par FFmpeg, gel, noir, corruption                                         |
| `stalker-api.test.ts`   | authentification, points d'entrée, do_auth, bannissement, catalogue, pagination, EPG, VOD, séries, radio, archive, favoris |
| `chaos-network.test.ts` | latency, drop, expire-token, http-error, throttle, reset                                                                   |
| `chaos-content.test.ts` | freeze (octets reçus, PTS figé, reprise), blackscreen (`blackdetect`/`silencedetect`), corrupt (erreurs de décodage)       |
| `e2e/portal.e2e.ts`     | Playwright : portail lancé comme processus, handshake, HLS, chaos                                                          |

Les tests de chaos observent le flux de l'extérieur, en temps réel : comptez une à deux minutes.

## Dimensionnement

À connaître avant tout déploiement :

| Grandeur                                              | Valeur                    |
| ----------------------------------------------------- | ------------------------- |
| Un spectateur HD                                      | ≈ 3 Mbit/s ≈ 1,3 Go/heure |
| 100 spectateurs simultanés                            | ≈ 300 Mbit/s en sortie    |
| Remux (`-c copy`)                                     | coût CPU négligeable      |
| Transcodage AC3 → AAC                                 | faible                    |
| Transcodage HEVC → H.264 sans accélération matérielle | ≈ un cœur CPU par flux    |

Le relais mutualise une connexion amont par chaîne, quel que soit le nombre de spectateurs : le
coût amont dépend du nombre de chaînes regardées, le coût aval du nombre de spectateurs. C'est
pourquoi la cible initiale est l'auto-hébergement.

## Limite assumée

Si la source amont est coupée plus longtemps que la profondeur du tampon et qu'aucune source
alternative n'existe, la lecture s'arrête. Aucun tampon ne fabrique des images qui n'arrivent pas.
