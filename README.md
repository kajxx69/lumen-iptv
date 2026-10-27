# Lumen

Lecteur IPTV (Stalker Portal) centré sur la résilience. Voir [PROJECT.md](PROJECT.md) pour la spécification.

**État : phase 3** — portail factice et chaos (0), client Stalker (1), backend Fastify : API,
comptes et chiffrement des portails (2), relais avec tampon glissant et bascule de source (3).

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
pnpm test                 # tests Vitest : rapides en parallèle, puis temps réel un par un
pnpm test:fast            # seulement les rapides (pendant le développement)
pnpm test:e2e             # Playwright : deux portails (18080, 18081) + backend (18090)
pnpm check                # typecheck + lint + format + tests
```

Au premier lancement, le portail génère avec FFmpeg deux boucles de 64 s (mire et écran noir)
dans `tools/fake-portal/.cache/assets` (20 à 60 s selon la machine). Elles sont ensuite réutilisées.

Avec Docker :

```sh
docker compose up --build                  # backend sur :8090 + un portail factice sur :8080
docker compose --profile multi up --build  # + un second portail (:8081), même chaînes, autres noms
```

## Le backend

```sh
# PowerShell : $env:LUMEN_MASTER_KEY = ... ; bash : export LUMEN_MASTER_KEY=...
LUMEN_MASTER_KEY=$(openssl rand -base64 32) \
LUMEN_ADMIN_PASSWORD='un-mot-de-passe-long' \
LUMEN_COOKIE_SECURE=false \
pnpm server                                 # http://localhost:8090
```

| Variable                                                 | Rôle                                                                              | Défaut            |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------- |
| `LUMEN_MASTER_KEY`                                       | **obligatoire** : 32 octets base64, chiffre URL, MAC et identifiants des portails | —                 |
| `LUMEN_ADMIN_PASSWORD`                                   | crée le compte `admin` au premier démarrage                                       | —                 |
| `LUMEN_DATABASE_PATH`                                    | base SQLite                                                                       | `./data/lumen.db` |
| `LUMEN_COOKIE_SECURE`                                    | cookie `Secure` ; `false` pour un accès HTTP en réseau local                      | `true`            |
| `LUMEN_MAX_STREAMS_PER_USER` / `LUMEN_MAX_STREAMS_TOTAL` | plafonds de lectures simultanées                                                  | `4` / `20`        |
| `LUMEN_API_REQUESTS_PER_MINUTE`                          | quota par utilisateur                                                             | `600`             |
| `LUMEN_CATALOG_TTL_MS`                                   | âge avant rafraîchissement du catalogue en arrière-plan                           | 6 h               |
| `LUMEN_RELAY_BUFFER_S`                                   | profondeur du tampon glissant de chaque chaîne (6 à 120 s)                        | `30`              |
| `LUMEN_RELAY_LINGER_MS`                                  | délai de grâce d'une chaîne sans spectateur                                       | 15 s              |
| `LUMEN_METRICS_TOKEN`                                    | active `/metrics` (Prometheus) avec ce jeton Bearer, 16 caractères au moins       | désactivé         |

Toutes les variables sont décrites dans [apps/server/src/config.ts](apps/server/src/config.ts).
**Perdre la clé maître rend les portails enregistrés illisibles** : sauvegardez-la à part.

API (toutes les routes sauf `/api/health` et `/api/auth/login` exigent une session) :

| Route                                                                                                                                         | Rôle                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`                                                                           | session par cookie `HttpOnly`           |
| `POST /api/users`                                                                                                                             | création de compte (admin)              |
| `GET/POST /api/portals`, `DELETE /api/portals/:id`, `POST /api/portals/:id/sync`                                                              | portails ; l'ajout vérifie l'abonnement |
| `GET /api/portals/:id/genres`, `…/channels` (ETag, gzip), `…/channels/:cid/logo`, `…/channels/:cid/epg?from&to`, `…/vod?page&category&search` | catalogue                               |
| `POST /api/playback {portalId, channelId, fallbacks?}`, `DELETE /api/playback/:sid`                                                           | lecture via le relais                   |
| `GET /api/playback/:sid/index.m3u8`, `GET /api/playback/:sid/seg/:n.ts`                                                                       | playlist HLS du relais et ses segments  |
| `GET /metrics` (jeton `LUMEN_METRICS_TOKEN`, hors session)                                                                                    | métriques Prometheus                    |

Le navigateur ne voit jamais l'URL du portail, la MAC, les tokens ni les liens de lecture amont.

## Le relais

Chaque chaîne regardée a **un** relais, partagé par tous ses spectateurs : une seule connexion
amont, quel que soit leur nombre (les portails limitent les connexions par MAC).

```
 Amont (source A, puis B)        Relais                          Lecteur
 flux TS continu  ──┐            découpeur → segments numérotés   toujours la même URL :
 ou playlist HLS  ──┴──► entrée ─► tampon glissant (30 s) ───────► /api/playback/<sid>/index.m3u8
```

- **Le relais fabrique sa propre playlist.** Il découpe le flux amont aux images clés (≈ 2 s,
  1 s pour le premier segment afin de démarrer vite), place PAT/PMT en tête de chaque segment
  et numérote lui-même les segments. La numérotation ne dépend jamais de l'amont.
- **Changement de source** (panne, lien expiré, 403) : la même playlist continue, numéro
  suivant, avec `EXT-X-DISCONTINUITY` à la jonction ; `EXT-X-DISCONTINUITY-SEQUENCE` glisse
  avec la fenêtre (RFC 8216). Le lecteur ne se réinitialise pas.
- **Politique de reprise** : nouveau `create_link` sur la même source, puis source de secours
  suivante, puis attente exponentielle (200 ms → 10 s, ±20 %). Tant que des spectateurs ont
  encore du tampon, l'attente est plafonnée à 2 s : la reprise doit arriver avant la fin de
  leur tampon.
- Sources de secours : `fallbacks` dans `POST /api/playback` (la même chaîne sur d'autres
  portails). Leur choix par score de santé arrive en phase 5.
- Une chaîne quittée garde son relais 15 s (retour instantané), sauf si une autre chaîne du
  même portail a besoin de la connexion.
- Segments sortis du tampon : cache LRU commun de 128 Mo (lecteurs en retard).

Mesures sur la machine de développement (tests temps réel) : démarrage 0,9 s, bascule A → B
0,25 s, 403 → bascule 0,16 s, reprise après coupure ou token expiré 0,7 à 1,3 s. Dans un vrai
navigateur, hls.js traverse la bascule sans rechargement, sans erreur ni image figée.

### Observabilité

```sh
# .env : LUMEN_METRICS_TOKEN=<au moins 16 caractères>
docker compose --profile observability up --build   # Grafana sur http://localhost:3000
```

Le tableau de bord « Lumen — relais et résilience » (provisionné depuis `docker/grafana/`)
affiche connexions amont, spectateurs, démarrage et reprise au 95e centile, bascules, pannes par
type, échecs de `create_link`, bande passante entrante et sortante, mémoire des tampons. Aucune
métrique ne porte d'identifiant de portail, de chaîne ni d'utilisateur.

## Arborescence

```
packages/core/stalker, sources                       client Stalker, interface SourceProvider
packages/core/{catalog,resilience}                   phases 5 et 6
packages/protocol                                    schémas Zod partagés client/serveur
apps/server                                          backend Fastify
apps/web                                             client React (phase 4)
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

| Fichier                          | Couvre                                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `mpegts.test.ts`                 | lecture/écriture PTS, DTS, PCR 33 bits, compteurs de continuité                                                            |
| `renderer.test.ts`               | continuité des PTS au rebouclage, flux décodable par FFmpeg, gel, noir, corruption                                         |
| `stalker-api.test.ts`            | authentification, points d'entrée, do_auth, bannissement, catalogue, pagination, EPG, VOD, séries, radio, archive, favoris |
| `chaos-network.realtime.test.ts` | latency, drop, expire-token, http-error, throttle, reset                                                                   |
| `chaos-content.realtime.test.ts` | freeze (octets reçus, PTS figé, reprise), blackscreen (`blackdetect`/`silencedetect`), corrupt (erreurs de décodage)       |
| `e2e/portal.e2e.ts`              | Playwright : portail lancé comme processus, handshake, HLS, chaos                                                          |

Côté backend (`apps/server/test`) :

| Fichier                     | Couvre                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| `relay/segmenter.test.ts`   | découpe aux images clés (drapeau RAI ou analyse H.264), coupe forcée, sauts d'horodatage, resynchro       |
| `relay/window.test.ts`      | numérotation, éviction, `DISCONTINUITY-SEQUENCE`, playlist exacte, cache LRU                              |
| `relay/upstream.test.ts`    | lecture des playlists HLS amont, politique de reprise et de bascule                                       |
| `relay.realtime.test.ts`    | deux portails réels : bascule < 2 s, 403, coupure, token expiré, 50 spectateurs = 1 connexion, libération |
| `playback.realtime.test.ts` | sessions : quotas, propriétaire, sources de secours, expiration                                           |
| `e2e/relay-switch.e2e.ts`   | hls.js dans un navigateur : bascule traversée sans rechargement, erreur ni image figée                    |

Les fichiers `*.realtime.test.ts` mesurent des délais réels. `pnpm test` les lance après les
autres, un par un : une mesure de bascule n'a de valeur que sur une machine calme.

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

Le tampon du relais ne protège que la part dont le lecteur est en retard sur le direct : un
lecteur collé au direct n'a que ses propres secondes d'avance. Le placement du lecteur (retard
visé ≈ 20 s, construit après un démarrage court) est l'objet du tampon client adaptatif (phase 6).

À la jonction entre deux sources, l'image peut sauter de quelques secondes : deux serveurs
amont ne sont pas synchronisés à l'image près, et la plupart des portails ne donnent aucun
repère commun. Un segment HLS amont manquant est réessayé sur la même source puis sauté ; le
redemander à une autre source exigerait des horodatages `PROGRAM-DATE-TIME` fiables des deux côtés.
