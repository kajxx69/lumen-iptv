# Lumen

Lecteur IPTV (Stalker Portal) centré sur la résilience. Voir [PROJECT.md](PROJECT.md) pour la spécification.

**État : phase 7** — portail factice et chaos (0), client Stalker (1), backend Fastify : API,
comptes et chiffrement des portails (2), relais avec tampon glissant et bascule de source (3),
client web : catalogue virtualisé, lecteur, guide des programmes, favoris (4), moteur de
résilience : détection de panne à trois niveaux, score de santé, sondes, tampon adaptatif (5),
agrégation multi-portails et dédoublonnage (6), transcodage adaptatif et LL-HLS (7).

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
pnpm --filter @lumen/web build   # interface web, servie ensuite par le backend
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
| `LUMEN_WEB_ROOT`                                         | build de l'interface web servi sur la même origine                                | `apps/web/dist`   |

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
| `GET /api/playback/:sid/status`                                                                                                               | état du relais : source active, santé   |
| `GET /api/portals/:id/epg?channels=a,b&from&to`                                                                                               | EPG groupé (40 chaînes au plus)         |
| `GET /api/favorites`, `PUT/DELETE /api/favorites/:portalId/:channelId`, `GET /api/recents`                                                    | favoris et récents, par compte          |
| `GET /metrics` (jeton `LUMEN_METRICS_TOKEN`, hors session)                                                                                    | métriques Prometheus                    |

Le navigateur ne voit jamais l'URL du portail, la MAC, les tokens ni les liens de lecture amont.

## Le client web

React 18, servi par le backend sur la même origine (cookie `SameSite=Strict`, CSP `'self'`, aucun
CORS). En développement : `pnpm server` puis `pnpm --filter @lumen/web dev` (Vite relaie `/api`).

- **Catalogue à grande échelle.** Liste virtualisée (une soixantaine de lignes dans le DOM, quel
  que soit le catalogue). Copie IndexedDB par portail : l'application s'ouvre aussitôt, hors ligne
  compris, puis revalide par ETag (un catalogue inchangé ne coûte qu'une réponse 304).
- **Recherche locale.** Index inversé maison (préfixes, accents et marqueurs de qualité ignorés,
  faute de frappe tolérée en second recours) : 36 ms au pire sur 100 000 chaînes.
- **Lecteur.** hls.js sur la playlist du relais. Erreurs réseau réessayées sans fin, session
  rouverte si elle disparaît, démarrage réessayé automatiquement. Indicateur de source et de santé.
  Le lecteur se place peu à peu à 20 s du direct, en jouant à 97 % de la vitesse (imperceptible) :
  ce retard permet au tampon du relais de couvrir une coupure sans que rien ne se voie.
- **Guide.** Grille sur 4 h, lignes virtualisées, ligne du présent, fiche du programme. EPG chargé
  par lots pour les seules lignes visibles.
- **Favoris et récents** synchronisés entre appareils (stockés par le backend), reprise de la
  dernière chaîne en un geste depuis l'accueil.
- **Télécommande.** Tout élément interactif est atteignable aux flèches (navigation spatiale,
  sans voisins déclarés à la main). Entrée valide, Retour/Échap revient. Dans le lecteur : haut/bas
  ou Page±/Chaîne± zappent, Espace met en pause.
- **Hors ligne.** Un service worker sert l'application ; catalogue, portails, favoris et récents
  viennent de la dernière copie locale.
- **Données mobiles.** 140 Ko compressés à l'ouverture ; le lecteur (hls.js) n'est téléchargé
  qu'au lancement d'une chaîne ; fichiers de build en cache un an ; logos chargés à l'approche.
- Les chaînes marquées « adulte » par le portail sont masquées en attendant le contrôle parental.

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
type, échecs de `create_link`, bande passante entrante et sortante, mémoire des tampons, ratio
de rebuffering mesuré par les lecteurs (cible < 0,5 %) et CPU du serveur. Aucune métrique ne
porte d'identifiant de portail, de chaîne ni d'utilisateur.

## Le moteur de résilience

Un lecteur ne peut pas inventer des images qui n'arrivent pas. Lumen masque les pannes en les
absorbant (tampon), en reprenant plus vite que le tampon ne se vide, et en basculant vers une
autre source — en choisissant celle-ci d'après ce qu'il sait déjà d'elle.

**Sources de secours trouvées seules.** Au lancement d'une chaîne, le serveur prend ses autres
sources dans la chaîne fusionnée (voir « La fusion des portails ») ; fusion désactivée, il s'en
tient au seul identifiant EPG. Le client n'a rien à fournir.

**Détection de panne à trois niveaux** (dans le relais, pour toutes les sources) :

| Niveau      | Signal                                                         | Seuil          | Réaction                           |
| ----------- | -------------------------------------------------------------- | -------------- | ---------------------------------- |
| Réseau      | socket fermée, délai, HTTP 4xx/5xx, plus aucun segment         | immédiat / 8 s | nouveau lien, puis source suivante |
| Progression | octets reçus mais horodatages vidéo figés                      | 1,5 s          | source suivante                    |
| Contenu     | image noire ou silence (FFmpeg `blackdetect`, `silencedetect`) | 10 s           | source suivante, source déclassée  |
| Débit       | la source livre moins de 40 % du débit du flux sur 4 s         | 4 s            | source suivante (s'il y en a une)  |

**Score de santé** (`packages/core/resilience`, 0 à 100) par couple (chaîne, portail) : latence
de `create_link`, premier octet, échecs de segments sur 5 min, gigue de débit, gels et pannes de
contenu sur l'heure, disponibilité sur 24 h. Les sources sont classées par score, jamais par
l'ordre de la liste ; les scores sont gardés dans SQLite et survivent au redémarrage.
`GET /api/portals/:id/channels/:cid/health` les expose.

**Sondes de fond.** Les favoris de tous les comptes sont sondés toutes les 15 min (lien, premier
octet, fermeture immédiate) ; le catalogue complet la nuit (3 h–6 h, 600 chaînes par heure, en
reprenant où le balayage s'est arrêté). Jamais sur un portail où quelqu'un regarde déjà une
chaîne : beaucoup n'acceptent qu'une connexion par MAC.

**Rechargement bloquant.** La playlist annonce `CAN-BLOCK-RELOAD` : le lecteur demande « le
segment suivant » et le reçoit à l'instant de sa publication, au lieu d'interroger toutes les
3 s. Pendant une bascule, c'est la différence entre une image qui continue et une image figée.

**Démarrage rapide de chaque source.** Pendant les 2 premières secondes d'une nouvelle source
(zapping, bascule, reconnexion), le relais publie des segments de 0,5 s sans attendre l'image
clé suivante : le lecteur, qui a peu d'avance à ce moment-là, reçoit la suite au fil de l'eau
au lieu d'attendre un GOP entier. Premier segment prêt en ≈ 0,9 s ; une panne une seconde après
le zapping passe sans image figée.

**Tampon client adaptatif.** Sur un relais déjà chaud, le lecteur part directement à 20 s du
direct (de quoi couvrir une coupure de 15 s) ; sur un relais froid, il démarre au premier
segment et construit ce retard en lisant à 97 %. La cible monte jusqu'à 60 s quand le réseau se
montre instable (coupure de lecture, segments lents), et redescend doucement ensuite.

**Image jamais bloquée sur une jonction.** Au passage d'une source à l'autre, Chrome peut
s'arrêter sur un trou de quelques millisecondes entre pistes. Le lecteur le détecte en 200 ms
et le franchit (saut du trou ou pas de 0,1 s), là où hls.js attendrait 1 à 2 s.

Variables : `LUMEN_RELAY_FAST_START_S`, `LUMEN_RELAY_FIRST_SEGMENT_TARGET_S`,
`LUMEN_FREEZE_DETECTION_MS`, `LUMEN_CONTENT_FAILURE_S`, `LUMEN_CONTENT_DETECTION`,
`LUMEN_FFMPEG_PATH`, `LUMEN_PROBES`, `LUMEN_PROBE_FAVORITES_INTERVAL_MS`,
`LUMEN_PROBE_CATALOG_START_HOUR` / `_END_HOUR` / `_PER_HOUR` (voir `apps/server/src/config.ts`).
L'analyse d'image exige FFmpeg sur le serveur ; sans lui, elle se désactive avec un avertissement.

## La fusion des portails

Avec plusieurs portails, la même chaîne y paraît sous des noms différents (`FR | CANAL+ FHD`,
`CANAL PLUS France`, `Canal + HD`). La vue **« Tous les portails »**, proposée par défaut dès
deux portails, en montre une seule entrée portant toutes ses sources ; le lecteur choisit la
meilleure par score de santé et bascule sur les autres en cas de panne. Une chaîne ouverte depuis
la vue fusionnée ou depuis la vue d'un portail partage la même connexion amont.

Pipeline (`packages/core/catalog`, pur et testé) :

1. **Normalisation** : préfixes et suffixes pays, marqueurs de qualité, accents, casse ; « Plus » et
   « + » réunis.
2. **Empreinte** : nom normalisé et identifiant EPG proposent les rapprochements.
3. **Confirmation par la grille** : chaque rapprochement entre deux portails est vérifié la nuit
   (fenêtre des sondes, 300 paires par heure, jamais sur un portail occupé) en comparant 6 h de
   programmes. Grilles différentes : le rapprochement est défait. Avis revérifié chaque semaine.
4. **Fusion** : une entrée par chaîne, ses sources, un nom lisible, des genres réunis par
   intitulé. 100 000 entrées fusionnées en moins d'une seconde (empreintes calculées à la
   synchronisation).

**Corrections** (Réglages, administrateur) : chercher une chaîne, séparer une source ou la
déplacer vers la bonne chaîne ; chaque correction s'annule. Elles valent pour toute
l'installation et l'emportent sur l'automatisme. La fusion se désactive d'un bouton.

Favoris et récents désignent toujours une chaîne réelle (portail, chaîne) : une chaîne fusionnée
est favorite si l'une de ses sources l'est, et passer d'une vue à l'autre ne perd rien.

Variables : `LUMEN_GRID_CHECKS`, `LUMEN_GRID_CHECKS_PER_HOUR` (fenêtre :
`LUMEN_PROBE_CATALOG_START_HOUR` / `_END_HOUR`).

## Direct au plus près (LL-HLS)

Deux façons de regarder, au choix du spectateur, chaîne par chaîne (bouton **⚡ Direct au plus
près** sur l'écran de lecture, mémorisé sur l'appareil) :

| Mode                | Retard sur le direct | Coupure amont de 15 s                | Pour…                          |
| ------------------- | -------------------- | ------------------------------------ | ------------------------------ |
| Confort (défaut)    | ≈ 20 s, jusqu'à 60 s | invisible                            | tout le reste                  |
| Direct au plus près | 3 s, jusqu'à 8 s     | visible au bout de quelques secondes | le match, le direct qui compte |

Le relais découpe chaque segment en **parties de 0,5 s** (`EXT-X-PART`, PAT et PMT en tête de
chacune) ; la playlist d'une session « direct » les annonce, avec `PART-HOLD-BACK` (1,5 s),
la partie suivante en indice de préchargement (`EXT-X-PRELOAD-HINT`) et le rechargement
bloquant par partie (`_HLS_part`). La partie annoncée est servie dès qu'elle paraît. Les
sessions confort, sur le même relais, ne voient aucune partie. Le format reste MPEG-TS de bout
en bout (choix délibéré, écart à PROJECT.md qui suggérait fMP4 : le moteur de résilience, la
bascule et le démarrage rapide reposent sur TS, que hls.js convertit à peu de frais).

Mesuré (machine de test, portail factice) : confort à 26 s du direct, « direct au plus près »
à **3 s** ; partie annoncée servie 0,4 s après la demande.

## Transcodage adaptatif

Le serveur ne convertit que ce que le navigateur ne lit pas (PROJECT.md §8) :

| Flux amont       | Navigateur qui le lit             | Sinon                             |
| ---------------- | --------------------------------- | --------------------------------- |
| H.264, AAC, MP3  | tous : **copié tel quel**         | —                                 |
| AC-3             | annoncé par le navigateur : copié | → AAC (peu coûteux, vidéo copiée) |
| E-AC-3, AAC LATM | Safari natif (E-AC-3) : copié     | → AAC                             |
| HEVC             | annoncé par le navigateur : copié | → H.264 (coûteux)                 |
| MPEG-2           | aucun                             | → H.264 (coûteux)                 |

- **Codecs** lus dans la PMT du flux (types de flux et descripteurs DVB), sans attendre
  `ffprobe` : la décision est instantanée. **Capacités** du navigateur détectées par le client
  (`MediaSource.isTypeSupported`, ou `canPlayType` en HLS natif) et transmises à la lecture.
- **Une connexion amont** par chaîne : la sortie directe et chaque sortie convertie en sont
  nourries ; une sortie convertie est partagée par tous les spectateurs qui en ont besoin, et
  s'arrête avec le dernier. Amorcée avec le flux récent, elle démarre sans attendre d'image
  clé (MPEG-2 + AC-3 → H.264 + AAC : 3 s sur la machine de test). Une bascule de source la
  relance, jonction marquée.
- **Accélération matérielle** : au démarrage, le serveur essaie NVENC, Quick Sync, AMF, VAAPI
  puis VideoToolbox par un encodage d'essai, et garde le premier qui marche. Sinon, **repli
  logiciel** (libx264) avec avertissement dans les journaux, image réduite à 720p, et
  l'indicateur du lecteur précise « image convertie (qualité réduite) ». Conversions vidéo
  simultanées plafonnées (`LUMEN_TRANSCODE_MAX_VIDEO`, 2) : au-delà, un refus clair, réessayé
  automatiquement par le lecteur.
- **Docker** : FFmpeg est dans l'image ; pour VAAPI, monter `/dev/dri` dans le conteneur ;
  pour NVENC, le runtime NVIDIA.

Variables : `LUMEN_TRANSCODING`, `LUMEN_TRANSCODE_ENCODER` (`auto`, `software` ou un nom
d'encodeur), `LUMEN_TRANSCODE_MAX_VIDEO`, `LUMEN_TRANSCODE_MAX_HEIGHT`,
`LUMEN_TRANSCODE_AUDIO_BITRATE_KBPS`, `LUMEN_RELAY_PART_TARGET_S`. Métriques :
`lumen_transcodes_active`, `lumen_transcodes_video_active`, `lumen_transcode_hardware`.

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
| `library.test.ts`           | favoris par compte, EPG groupé                                                                            |

Côté client web (`apps/web`) : `test/search.test.ts` (recherche, 100 000 entrées < 50 ms),
`test/logic.test.ts` (navigation spatiale, grille du guide, retard sur le direct) et
`e2e/app.e2e.ts` (interface réelle : liste virtualisée, recherche, favoris conservés, lecture et
zapping au clavier, guide, ouverture hors ligne).

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
visé ≈ 20 s, construit après un démarrage court) est l'objet du tampon client adaptatif.

À la jonction entre deux sources, l'image peut sauter de quelques secondes : deux serveurs
amont ne sont pas synchronisés à l'image près, et la plupart des portails ne donnent aucun
repère commun. Un segment HLS amont manquant est réessayé sur la même source puis sauté ; le
redemander à une autre source exigerait des horodatages `PROGRAM-DATE-TIME` fiables des deux côtés.
