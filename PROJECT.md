# PROJECT.md — Lecteur IPTV Stalker

## Mission

Tu construis **Lumen**, un lecteur IPTV professionnel dont la caractéristique
centrale est la résilience : la lecture ne doit jamais s'interrompre visiblement,
même quand le serveur amont est lent, instable ou temporairement hors service.

Cible initiale : **application web**. Le code doit être structuré pour que les
clients Android, macOS et Windows réutilisent plus tard le même cœur métier sans
réécriture.

Protocole principal : **Stalker Portal (middleware MAG)**, supporté de façon
complète. Xtream Codes et M3U/XMLTV sont des sources secondaires, ajoutées
derrière la même interface abstraite.

## Ton rôle

Tu es l'ingénieur principal de ce projet. Tu travailles par phases, tu écris les
tests avant le code sur tout ce qui touche à la résilience, et tu ne déclares une
phase terminée que lorsque ses critères d'acceptation mesurables sont atteints.

Règles de conduite :

1. **Jamais de code non testé sur le chemin critique.** Le chemin critique est :
   authentification portail, résolution de lien, relais, bascule de source.
2. **Jamais de valeur magique.** Tout délai, seuil ou taille de tampon est une
   constante nommée et configurable, documentée avec sa raison d'être.
3. **Jamais de dépendance à un service externe payant** sans me demander d'abord.
4. **Si une exigence est ambiguë, pose la question** avant d'implémenter. Ne
   devine pas sur l'architecture.
5. **Arrête-toi à la fin de chaque phase** et présente un rapport court : ce qui
   est fait, ce qui est testé, ce qui reste ouvert.

## Contexte d'exploitation

- Utilisateurs principalement en Afrique de l'Ouest : réseaux mobiles à latence
  élevée et débit variable, coût des données important.
- Modèle de déploiement visé : **auto-hébergé**, image Docker, l'utilisateur
  fournit son propre abonnement et son propre portail.
- Aucun contenu n'est stocké, servi ou redistribué par le projet. Le logiciel est
  un client neutre.




  ## Architecture

Trois couches, séparation stricte :

    [ Client web React ]
            ↕ HTTP/JSON + HLS
    [ Backend Node : API + relais de flux ]
            ↕ HTTP (en-têtes MAG) + MPEG-TS/HLS
    [ Portail Stalker / serveurs de flux ]

Le backend est **obligatoire**, pas optionnel. Raisons, à respecter :

- Un navigateur ne peut pas envoyer les en-têtes exigés par Stalker
  (`Cookie: mac=...`, `User-Agent` et `X-User-Agent` de type MAG250).
- La plupart des portails n'envoient aucun en-tête CORS.
- Une page HTTPS ne peut pas lire un flux HTTP (contenu mixte bloqué).
- Les portails limitent les connexions simultanées par MAC : le relais mutualise
  une connexion amont unique entre plusieurs spectateurs.

## Stack imposée

| Couche | Technologie | Justification |
| --- | --- | --- |
| Monorepo | pnpm workspaces + TypeScript strict | Cœur partagé entre web et futurs clients |
| Backend | Node.js 22 LTS, Fastify | Performance sur flux, écosystème mature |
| Lecture vidéo web | hls.js + mpegts.js | Couvre HLS et MPEG-TS natif |
| Transcodage | FFmpeg (processus enfant) | Remux et transcodage à la demande |
| Client web | React 18 + Vite + TanStack Query | Déjà maîtrisé, rapide à itérer |
| État client | Zustand | Léger, suffisant ici |
| Stockage serveur | SQLite (better-sqlite3) | Auto-hébergement sans service externe |
| Cache catalogue client | IndexedDB (Dexie) | Recherche hors ligne sur 100 000 entrées |
| Tests | Vitest + Playwright | Unitaires, intégration, bout en bout |
| Conteneur | Docker + docker-compose | Cible de déploiement |

N'ajoute aucune dépendance lourde hors de cette liste sans me demander.

## Arborescence attendue

    lumen/
    ├── packages/
    │   ├── core/            # Logique métier pure, zéro I/O navigateur
    │   │   ├── stalker/     # Client protocole Stalker
    │   │   ├── sources/     # Interface abstraite + Xtream, M3U
    │   │   ├── catalog/     # Normalisation, dédoublonnage, fusion
    │   │   └── resilience/  # Score de santé, politique de bascule
    │   └── protocol/        # Types partagés client/serveur (Zod)
    ├── apps/
    │   ├── server/          # Fastify : API, relais, transcodage
    │   └── web/             # React
    ├── tools/
    │   └── fake-portal/     # Serveur Stalker factice + injection de pannes
    └── docker/

Règle d'or : `packages/core` ne doit importer **ni** `fetch` du navigateur, **ni**
de module Node spécifique. Toute I/O passe par des interfaces injectées. C'est ce
qui rend le portage Android et desktop possible sans réécriture.



## Spécification Stalker Portal

Le package `packages/core/stalker` implémente un client complet du middleware
Stalker. Toutes les requêtes passent par `server/load.php` (certains portails
utilisent `portal.php` ou `c/portal.php` : la découverte du point d'entrée doit
être automatique, avec essai successif).

### En-têtes obligatoires sur chaque requête

    Cookie: mac=<MAC>; stb_lang=fr; timezone=Africa/Abidjan
    User-Agent: Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3
                (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3
    X-User-Agent: Model: MAG250; Link: WiFi
    Authorization: Bearer <token>        # après handshake
    Referer: <url du portail>/c/

Ces valeurs doivent être configurables par profil d'appareil (MAG250, MAG254,
MAG322), car certains portails filtrent sur le modèle déclaré.

### Séquence d'authentification

1. `type=stb&action=handshake` → récupère `token`.
2. `type=stb&action=get_profile` avec le token → vérifie le compte, récupère
   `status`, la date d'expiration et les capacités du portail.
3. `type=stb&action=do_auth` avec login/mot de passe **uniquement** si le profil
   l'exige.
4. Maintien de session : `get_profile` périodique (intervalle configurable,
   défaut 10 minutes) et renouvellement automatique du token sur HTTP 401/403.

### Actions à implémenter intégralement

| Domaine | Actions |
| --- | --- |
| TV | `get_genres`, `get_all_channels`, `get_ordered_list` (paginé), `get_link`, `create_link` |
| EPG | `get_short_epg`, `get_epg_info`, `get_data_table` |
| VOD | `type=vod` : `get_categories`, `get_ordered_list`, `create_link` |
| Séries | `type=series` : catégories, saisons, épisodes |
| Radio | `type=radio` : catégories et liste |
| Archive | `type=tv_archive` : `create_link` avec `cmd` horodaté |
| Compte | `get_profile`, `get_account_info`, `get_main_info` |
| Favoris | `get_fav_items`, `set_fav` |

### Règles critiques

- **L'URL retournée par `create_link` est éphémère et liée au token.** Elle doit
  être régénérée à chaque lecture et à chaque reconnexion. Ne la persiste jamais
  en base ni en cache long.
- La réponse de `create_link` contient souvent un préfixe parasite du type
  `ffmpeg ` ou `auto ` : il faut le retirer avant usage.
- `get_ordered_list` est paginé : `p=<page>`, environ 14 entrées par page selon
  les portails. Le nombre total vient de `total_items`. Implémente une
  pagination avec concurrence limitée (4 requêtes parallèles maximum) et
  reprise sur échec.
- Les portails sont tolérants aux variantes mais pas uniformes : prévois un
  **parseur défensif** qui accepte `js` absent, des champs en chaîne au lieu de
  nombre, et des tableaux vides. Toute réponse est validée par un schéma Zod
  avec valeurs par défaut, jamais consommée brute.
- Limite le débit de requêtes vers le portail (défaut : 5 requêtes/seconde,
  configurable). Un portail saturé bannit la MAC.

### Interface abstraite

Définis `SourceProvider` dans `packages/core/sources` :

```ts
interface SourceProvider {
  authenticate(): Promise<Session>
  listChannels(opts?: ListOptions): AsyncIterable<Channel>
  listVod(opts?: ListOptions): AsyncIterable<VodItem>
  resolveStream(ref: StreamRef): Promise<ResolvedStream>
  getEpg(channelId: string, window: TimeWindow): Promise<EpgEntry[]>
  capabilities(): ProviderCapabilities
}
```

`StalkerProvider` l'implémente en premier. `XtreamProvider` et `M3uProvider`
viennent ensuite sans toucher au reste du système.


## Moteur de résilience — spécification

C'est le cœur différenciant du projet. Écris les tests avant le code pour toute
cette section.

### Principe

Un lecteur ne peut pas inventer des données qui n'arrivent pas. Il peut masquer
les défaillances en les absorbant (tampon), en reconnectant plus vite que le
tampon ne se vide, et en basculant vers une autre source. Le moteur doit être
**prédictif** autant que réactif.

### 1. Relais avec tampon glissant (`apps/server/relay`)

- Une connexion amont par flux, partagée entre N spectateurs.
- Ring buffer en mémoire, 30 secondes par défaut, 120 secondes maximum,
  configurable.
- **Réécriture de manifeste HLS** : le client reçoit toujours la même URL de
  playlist. Quand le serveur amont change, le relais continue la même playlist
  avec une numérotation de segments continue et `EXT-X-DISCONTINUITY` au point
  de jonction. Le lecteur client ne se réinitialise pas.
- Segments récents conservés en cache LRU pour le zapping et le timeshift.
- Un segment manquant est re-demandé sur une source alternative avant d'être
  servi ; s'il reste introuvable après le délai imparti, il est sauté plutôt que
  de bloquer la playlist.

### 2. Détection de panne — trois niveaux

La détection d'erreur réseau seule est insuffisante. Implémente les trois :

| Niveau | Signal | Seuil par défaut |
| --- | --- | --- |
| Réseau | Socket fermée, timeout, HTTP 4xx/5xx | immédiat |
| Progression | `currentTime` ou PTS/DTS n'avance plus alors que des octets arrivent | 2,5 s |
| Contenu | Image noire ou silence prolongé (FFmpeg `blackdetect`, `silencedetect`) | 10 s |

Le niveau « progression » est le plus important : c'est la cause numéro un des
gels que les lecteurs classiques ne détectent jamais. Un flux peut avoir une
socket active, recevoir des octets, et être figé.

### 3. Score de santé par source

Chaque couple (chaîne, source) porte un score recalculé en continu :

```ts
interface SourceHealth {
  resolveLatencyMs: number      // temps de create_link
  timeToFirstByteMs: number
  segmentFailureRate: number    // fenêtre glissante 5 min
  bitrateJitter: number
  freezeEventsPerHour: number
  uptime24h: number
  score: number                 // 0–100, pondéré
}
```

Le choix de source au zapping utilise ce score, jamais l'ordre de la liste.
Persiste les scores en SQLite pour qu'ils survivent au redémarrage.

### 4. Sondes de fond

Un worker teste périodiquement les chaînes : les favorites toutes les 15
minutes, le catalogue complet une fois par nuit, avec débit limité. Objectif :
connaître l'état d'une chaîne **avant** que l'utilisateur clique dessus.

### 5. Politique de bascule

```
panne détectée
  → tenter nouveau create_link sur la MÊME source (le lien a pu expirer)
  → si échec : basculer sur la source alternative au meilleur score
  → si aucune alternative : retry exponentiel sur la source d'origine
     (200 ms, 400 ms, 800 ms … plafonné à 10 s, avec gigue aléatoire)
  → n'afficher une erreur à l'utilisateur QUE si le tampon est vide
     ET que toutes les sources ont échoué
```

Pendant toute cette séquence, le client continue de lire son tampon. Aucun
indicateur de chargement ne doit apparaître tant qu'il reste plus de 3 secondes
de tampon.

### 6. Tampon client adaptatif

- Démarrage avec un tampon court (3 s) pour un zapping rapide.
- Croissance automatique jusqu'à 60 s quand la gigue mesurée dépasse le seuil.
- Décroissance lente quand le flux redevient stable.
- Paramètres hls.js : `maxBufferLength`, `maxMaxBufferLength`,
  `liveSyncDurationCount`, pilotés dynamiquement, jamais figés.

### 7. Hot standby (optionnel, activable)

Sur les chaînes marquées importantes, le relais ouvre discrètement la source
n°2 en parallèle. En cas de gel sur la n°1, la bascule est instantanée. Coût :
bande passante doublée. Désactivé par défaut, activable par chaîne.

### 8. Transcodage adaptatif

- `ffprobe` sonde le flux ; les capacités du navigateur sont détectées côté
  client et transmises.
- **Passthrough** si le navigateur lit nativement.
- **Remux** (`-c copy`) vers HLS fMP4 en priorité : coût CPU quasi nul.
- **Transcodage** seulement si nécessaire. Audio AC3 → AAC coûte peu. Vidéo
  HEVC ou MPEG-2 → H.264 coûte cher : accélération matérielle obligatoire
  (NVENC, QSV, VAAPI) avec repli logiciel et avertissement explicite.
- LL-HLS activable pour descendre la latence à 3–5 s sur le sport.

### 9. Limite à documenter honnêtement

Si le serveur amont est coupé plus longtemps que la profondeur du tampon et
qu'aucune source alternative n'existe, la lecture s'arrête. C'est inévitable.
Le code et la documentation doivent l'énoncer clairement plutôt que de
prétendre à une infaillibilité absolue.


## Client web

### Catalogue à grande échelle

Un portail peut exposer 20 000 à 100 000 entrées. Ce qui casse à cette échelle,
et ce qu'il faut donc imposer dès le départ :

- **Listes virtualisées obligatoires** (`@tanstack/react-virtual`). Aucun rendu
  de liste complète, jamais.
- **Cache IndexedDB versionné** : le catalogue est téléchargé une fois, puis
  seuls les deltas sont récupérés. L'ouverture de l'app doit être instantanée
  même hors ligne.
- **Index de recherche local** avec correspondance floue (MiniSearch ou
  équivalent léger), fonctionnant sans réseau, réponse en moins de 50 ms sur
  100 000 entrées.
- Images chargées paresseusement, avec placeholder et repli si le logo manque.

### Normalisation et fusion multi-sources

Quand l'utilisateur configure plusieurs portails, la même chaîne y apparaît sous
des noms différents (`FR | CANAL+ FHD`, `CANAL PLUS France`, `C+ 1080`).
Implémente un pipeline en trois étapes dans `packages/core/catalog` :

1. **Normalisation** : retrait des préfixes pays, marqueurs de qualité
   (`FHD`, `4K`, `SD`), caractères parasites, mise en minuscules, suppression
   des accents.
2. **Empreinte** : nom normalisé + identifiant EPG + similarité de la grille de
   programmes sur 6 heures. La grille EPG est le signal le plus fiable.
3. **Fusion** : une entrée unique portant N sources classées par score de santé.

L'utilisateur voit une chaîne propre et unique ; le moteur dispose de plusieurs
filets de sécurité. Rends la fusion désactivable et les regroupements
corrigeables manuellement : l'automatisme se trompera parfois.

### Enrichissement

- Logos : dépôt communautaire configurable, avec cache local.
- EPG : source XMLTV externe utilisable quand celle du portail est pauvre ou
  absente ; fusion des deux.
- VOD : métadonnées TMDb optionnelles (affiche, synopsis, note, année), clé API
  fournie par l'utilisateur, jamais embarquée.

### Interface

Conçue dès le départ pour trois modes d'entrée : souris, tactile, **télécommande
D-pad**. Le support D-pad ajouté après coup est un chantier ingrat ; chaque
composant interactif doit être focalisable et navigable aux flèches dès sa
création.

Écrans à livrer :

- Accueil : reprise de lecture, favoris, chaînes récentes.
- TV en direct : liste par genre, guide EPG en grille, aperçu au survol.
- Lecteur : contrôles, sélection piste audio et sous-titres, qualité, indicateur
  de source active et de santé.
- VOD et séries : catalogue, fiche détail, saisons et épisodes, reprise.
- Recherche globale instantanée sur TV, VOD et séries.
- Réglages : portails, profils réseau, tampon, parental, diagnostics.

### Fonctions à forte valeur d'usage

| Fonction | Détail |
| --- | --- |
| Mosaïque multi-flux | 2, 4 ou 9 chaînes simultanées, un seul audio actif |
| Zapping instantané | Pré-résolution des liens des chaînes voisines |
| Timeshift et catch-up | Barre de progression réelle sur les portails qui l'exposent |
| Enregistrement serveur | Programmation depuis l'EPG, fichier récupérable |
| Reprise de lecture | Synchronisée entre appareils via le backend |
| Profils et contrôle parental | Code PIN, masquage de catégories |
| PiP, Chromecast, AirPlay | Via les API natives du navigateur |
| Sous-titres | Internes et fichiers externes |

### Adaptation au réseau

Différenciateur réel sur les réseaux mobiles ouest-africains :

- **Mode économie de données** : plafond de bitrate, option audio seul, compteur
  de consommation visible dans l'interface.
- **Profils automatiques** : qualité maximale en WiFi, bridée en données
  mobiles, détection du changement de réseau via l'API Network Information.
- **Tampon agressif au démarrage** sur réseau détecté comme instable.
- **Reprise automatique** après coupure totale de connexion, sans intervention.


## Serveur Stalker factice et ingénierie du chaos

C'est la phase 0, à construire **avant** tout le reste. Sans elle, rien n'est
vérifiable et la résilience n'est qu'une intention.

### `tools/fake-portal`

Un serveur Node qui implémente le protocole Stalker de façon réaliste :
handshake, profil, catégories, 5 000 chaînes générées, EPG, VOD, séries, et
diffusion de flux de test (mires FFmpeg avec horodatage incrusté, ce qui rend
les gels visibles à l'image).

Il expose une **API de contrôle des pannes** pour les tests :

```
POST /_chaos/latency        { ms: 3000, scope: "api" | "stream" }
POST /_chaos/drop           { durationMs: 10000, channelId: "42" }
POST /_chaos/expire-token
POST /_chaos/http-error     { code: 403, probability: 0.3 }
POST /_chaos/throttle       { bitrateKbps: 200 }
POST /_chaos/corrupt        { segmentProbability: 0.1 }
POST /_chaos/freeze         { durationMs: 8000 }   # octets envoyés, PTS figé
POST /_chaos/blackscreen    { durationMs: 15000 }
POST /_chaos/reset
```

Le scénario `freeze` est le plus important : il envoie des données valides sans
faire avancer l'horodatage. C'est le cas que la plupart des lecteurs ne
détectent pas.

### Suite de tests de chaos

Chaque scénario est un test automatisé Playwright mesurant l'expérience réelle
du spectateur, pas l'état interne du code.

| Scénario | Critère de réussite |
| --- | --- |
| Coupure amont 15 s | Aucune interruption visible, aucun indicateur de chargement |
| Coupure amont 90 s | Reprise automatique, pas d'erreur affichée si une source alternative existe |
| Token expiré en pleine lecture | Renouvellement transparent, lecture continue |
| HTTP 403 soudain | Nouveau `create_link` puis bascule, moins de 2 s |
| Gel PTS 8 s | Détecté en moins de 2,5 s, bascule effectuée |
| Écran noir 15 s | Détecté, source déclassée, bascule |
| Débit divisé par 5 | Descente de qualité, pas de rebuffering |
| Source A morte, B saine | Bascule en moins de 2 s, aucune coupure audio |
| Portail injoignable au démarrage | Catalogue servi depuis IndexedDB, message clair |
| 50 spectateurs, 1 chaîne | Une seule connexion amont, charge CPU stable |

### Critères d'acceptation mesurables du projet

Ce sont les chiffres qui déterminent si le projet atteint son objectif :

| Indicateur | Cible |
| --- | --- |
| Temps de démarrage d'une chaîne | < 2 s au 95e centile |
| Ratio de rebuffering | < 0,5 % du temps de visionnage |
| Taux d'échec au lancement | < 1 % |
| Durée de bascule entre sources | < 2 s, sans coupure audio |
| Latence en direct (LL-HLS actif) | 3 à 5 s |
| Ouverture du catalogue (100 000 entrées, cache chaud) | < 1 s |
| Recherche locale | < 50 ms |
| Couverture de tests sur `core/resilience` | > 90 % |

### Observabilité

Expose ces métriques en format Prometheus sur `/metrics`, et fournis un tableau
de bord Grafana prêt à l'emploi dans `docker/`. Sans mesure, les tampons se
règlent à l'aveugle.

Métriques minimales : temps de démarrage, ratio de rebuffering, bascules par
heure, échecs de résolution, connexions amont actives, CPU de transcodage,
bande passante sortante.


## Standards de code

- TypeScript en mode `strict`, `noUncheckedIndexedAccess` activé. Aucun `any`
  non justifié par un commentaire.
- Toute donnée venant du réseau est validée par un schéma Zod avant usage.
- Erreurs typées et discriminées, jamais de `throw` d'une chaîne.
- Journalisation structurée (Pino) avec identifiant de corrélation par session
  de lecture, pour pouvoir suivre une panne de bout en bout.
- Aucune valeur magique : tout seuil est une constante nommée dans un fichier
  `config` unique, documentée avec sa raison d'être.
- Commentaires réservés au « pourquoi ». Le « comment » doit se lire dans le
  code.

## Sécurité

Ce sont des exigences, pas des suggestions :

- **Chiffrement au repos des identifiants de portail** (URL, adresse MAC,
  tokens) avec une clé maître fournie par variable d'environnement. C'est la
  donnée la plus sensible du système.
- **Le relais doit être authentifié et limité en débit.** Un relais ouvert
  devient un proxy exploité par des tiers en quelques jours. Authentification
  obligatoire, quota par utilisateur, plafond de sessions simultanées.
- Jamais d'identifiant, de MAC ou de token dans les journaux, les URL ou les
  messages d'erreur. Masque-les systématiquement.
- En-têtes de sécurité HTTP, CSP stricte, pas de `eval`.
- Dépendances auditées, pas de paquet non maintenu sur le chemin critique.

## Dimensionnement à documenter

Produis dans le README un calcul de capacité : un spectateur en HD consomme
environ 1,3 Go par heure, soit à peu près 3 Mbps. Cent spectateurs simultanés
représentent de l'ordre de 300 Mbps en sortie. Le transcodage HEVC sans
accélération matérielle sature un cœur CPU par flux. Ces chiffres doivent être
connus avant tout déploiement, et c'est la raison pour laquelle le modèle
auto-hébergé est la cible initiale.

## Non-objectifs — ne les implémente pas

- Aucun hébergement, stockage ou redistribution de contenu.
- Aucun contournement de DRM, de chiffrement ou de protection d'accès.
- Aucun portail, abonnement ou identifiant embarqué dans le code ou les tests.
  Les tests utilisent exclusivement le serveur factice.
- Aucun scraping ou découverte automatique de portails tiers.
- Pas de télémétrie sortante vers un service externe : les métriques restent
  locales à l'instance.

Si une demande future entre en conflit avec ces non-objectifs, signale-le au
lieu de l'implémenter.
