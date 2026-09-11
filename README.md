# crowler

Crawler d'audit de liens : à partir d'une URL, il explore récursivement un site, relève le
status HTTP de chaque page, image, script et lien sortant, et exporte l'audit en CSV. Pour
chaque lien cassé, le rapport indique **la page qui contient le lien** et **le texte du lien** —
c'est ce qui rend l'audit directement actionnable.

Aucune dépendance : uniquement le runtime Bun. Pas de `bun install`, pas de `node_modules`,
pas d'étape de build.

## Démarrer

```bash
bun server.ts
```

Puis <http://localhost:3000>.

Les audits sont enregistrés dans `./data` (paramétrable avec `DATA_DIR`) : la barre de gauche
en garde l'historique et un audit passé se rouvre, avec ses exports, après un redémarrage.

Pour essayer sans site sous la main, un site de démonstration volontairement cassé est fourni :

```bash
bun fixture.ts
```

Il écoute sur le port 4000. Comme il tourne en local, il faut lever la garde réseau privé pour
l'auditer : `BLOCK_PRIVATE_IPS=0 bun server.ts`.

## Docker

```bash
docker compose up -d
```

C'est tout : `compose.yaml` construit l'image depuis le dépôt, aucun registre n'est nécessaire.
Le service répond sur <http://localhost:3000> et le volume `crowler-data` porte l'historique des
audits — sans lui, recréer le conteneur repart d'une ardoise vide. Image de 132 Mo, environ
60 Mo de RAM en usage.

Le conteneur tourne sans privilège : utilisateur non-root, système de fichiers en lecture seule
hormis `/app/data`, toutes les capacités retirées et `no-new-privileges`. Le sondage `/health`
est déclaré dans le `Dockerfile`, donc un gestionnaire de stacks affiche l'état réel du service
sans configuration supplémentaire.

Sans Compose, l'équivalent tient en une ligne :

```bash
docker build -t crowler . && docker run -p 3000:3000 -v crowler-data:/app/data crowler
```

### Réglages de la stack

Copiez `.env.example` en `.env` : `docker compose` le lit tout seul.

| Variable | Défaut | Effet |
|---|---|---|
| `CROWLER_PORT` | 3000 | port publié sur l'hôte ; le conteneur écoute toujours sur 3000 |
| `BLOCK_PRIVATE_IPS` | `1` | refuse les cibles sur réseau privé |
| `MAX_SESSIONS` | 50 | audits conservés ; au-delà, les plus anciens sont supprimés |
| `WEBHOOK_MIN_INTERVAL` | 60 | secondes minimum entre deux déclenchements d'un même preset |
| `DOMAINS` | vide | domaine public : label Caddy, et base des liens dans les notifications |
| `TZ` | `Europe/Paris` | fuseau des dates affichées dans les notifications ; l'image est en UTC |

Deux variables ne se règlent que dans l'image, parce que la stack en dépend : `PORT`, fixé à
3000 face à la publication ci-dessus, et `DATA_DIR`, fixé à `/app/data` face au volume. Hors
conteneur, elles valent `3000` et `./data`.

Une variante binaire unique est disponible si l'empreinte de l'image compte :
`bun run compile` produit un exécutable autonome déployable sur `scratch` ou `distroless`.

## Réglages

Tous modifiables dans l'interface, sous « Réglages ».

| Réglage | Défaut | Effet |
|---|---|---|
| Vérifier les liens externes | activé | teste tout ce qui est **hors du domaine**, sans l'explorer |
| Vérifier images, CSS et scripts | activé | teste les cibles de `img`, `script`, `link`, `iframe`, `video`, `audio` |
| Respecter robots.txt | activé | applique les règles `Disallow` / `Allow` / `Crawl-delay` |
| Explorer les sous-domaines | désactivé | `blog.exemple.fr` compte comme interne |
| Suivre les liens nofollow | désactivé | explore aussi les `rel="nofollow"` |
| Ignorer les query strings | désactivé | `?utm=…` ne crée plus d'URL distincte |
| Relever les balises SEO | activé | `title`, `description`, `h1`, canonique, `robots`, `lang` et volume de texte |
| Lire le sitemap du site | activé | ajoute les URLs du sitemap au crawl, et révèle les pages orphelines |
| Sitemap | vide | force une URL de sitemap ; vide = découverte par `robots.txt` puis `/sitemap.xml` |
| Notifier sur le bureau à la fin | activé | notification système quand l'audit se termine |
| Parallèle | 8 | requêtes simultanées |
| Délai | 0 ms | pause par worker entre deux requêtes |
| Profondeur max | 0 | 0 = illimité |
| Pages max | 10 000 | borne la mémoire |
| Timeout | 15 000 ms | par requête, en-têtes **et** corps |
| Exclure du crawl | vide | expressions régulières, une par ligne |

Les deux premiers réglages sont des catégories indépendantes : le premier porte sur
l'emplacement (hors domaine ou non), le second sur le rôle (asset ou non). Une image hébergée
sur un autre domaine appartient aux deux, il faut donc les deux cases pour qu'elle soit
requêtée. Décocher « liens externes » garantit qu'aucune requête ne sort du domaine, embeds
YouTube et CDN compris.

La colonne `kind` de l'export suit la même logique : `page` et `asset` sont sur le domaine
audité, `external` couvre tout le hors-domaine quel que soit son rôle. Les sous-domaines sont
hors domaine tant que « Explorer les sous-domaines » est décoché.

## Exclure des URLs

Le champ « Exclure du crawl » prend une expression régulière JavaScript par ligne. Chaque URL
découverte est testée, insensiblement à la casse, sur sa forme normalisée complète — schéma,
hôte, chemin et query — ce qui permet de filtrer sur autre chose que le chemin :

```
/wp-admin/          zone d'administration
\.pdf$              tous les PDF
[?&]utm_            URLs taguées de campagne
^https://mdc\.       un sous-domaine entier
/(en|de|es)/        les versions traduites
```

Une URL exclue n'est jamais requêtée et n'apparaît pas dans le rapport : vous avez demandé à ne
pas l'auditer, l'y lister n'ajouterait que du bruit. Le bandeau affiche le nombre de **liens**
écartés, occurrences comprises — un lien de navigation exclu présent sur 40 pages en compte 40.

Les motifs sont validés au lancement : un motif qui ne compile pas, qui dépasse 300 caractères
ou qui se révèle assez lent pour ralentir tout le crawl est refusé avec son message, avant que
le crawl démarre. Démarrer sur une URL que vos propres motifs excluent est aussi refusé, plutôt
que de produire un audit d'une seule page. Maximum 25 motifs.

Cette validation attrape le backtracking exponentiel, pas la lenteur polynomiale : un motif
alambiqué peut encore coûter du temps, borné par la troncature des URLs à 2 000 caractères.

## Historique

Chaque audit lancé s'inscrit dans la barre de gauche et y reste. Cliquer sur une entrée
recharge l'audit complet — répartition des statuts, liens cassés avec leurs referers, tableau
des URLs, exports CSV — et remet le formulaire sur les réglages utilisés, pour relancer le même
audit d'un clic. Un audit encore en cours se reprend en direct : rafraîchir la page pendant un
crawl le retrouve et se rebranche sur son flux d'événements.

Le stockage est un dossier par audit sous `DATA_DIR`, deux fichiers texte dedans :

```
data/ouviuok7/meta.json     cible, réglages, statistiques, nombre de liens cassés
data/ouviuok7/rows.jsonl    une URL auditée par ligne
```

Pas de base de données, donc pas de schéma ni de migration : l'historique se lit avec `cat`, se
filtre avec `grep`, se sauvegarde avec `cp` et se purge avec `rm`. Les lignes sont écrites et
relues en flux, un audit de 200 000 URLs ne passe jamais entier par la mémoire — y compris à
l'export, où le CSV d'un audit passé est produit en relisant le fichier ligne à ligne.

`meta.json` est écrit à l'ouverture de l'audit puis réécrit à sa fermeture, et `rows.jsonl` est
posé avant : un `finishedAt` non nul garantit donc que les lignes sont complètes. Un audit
laissé à `0` est un crawl que l'arrêt du serveur a coupé ; il est affiché « interrompu ».

Le dossier `data/` est ignoré par git et par le build Docker.

## Presets

Un preset, c'est la cible et ses réglages enregistrés sous un nom. Il sert à deux choses :
relancer le même audit sans le reconfigurer, et le déclencher de l'extérieur par webhook.

Sous « Réglages », en bas : entrez un nom et cliquez **Enregistrer**. Le preset reprend l'URL du
formulaire et l'ensemble des réglages affichés au moment de l'enregistrement. Le sélecteur à
gauche recharge un preset dans le formulaire, prêt à lancer ou à modifier.

À la **création**, un jeton est affiché avec la commande `curl` prête à coller dans un pipeline.
Il n'est montré qu'une fois : seule son empreinte SHA-256 est conservée, il est impossible de le
retrouver ensuite. Perdu, il se remplace avec **Régénérer le jeton** — l'ancien cesse
immédiatement de fonctionner.

Réenregistrer un preset existant met à jour sa cible et ses réglages **sans toucher au jeton** :
les webhooks déjà en place chez l'appelant continuent de marcher. Supprimer le preset invalide
son jeton.

Sous le sélecteur, le champ **Notification Google Chat** attache un espace au preset : ses
audits déclenchés par webhook y annoncent leur départ et leur bilan (voir
[Notifications Google Chat](#notifications-google-chat)). Comme le jeton, l'URL ne se relit pas
— elle porte ses secrets dans sa query string. Réenregistrer le preset en laissant le champ vide
la conserve ; **Retirer la notification** l'efface.

Les presets vivent dans un seul fichier, `presets.json` sous `DATA_DIR`, à côté des dossiers
d'audit. Maximum 25.

## Webhook

Un appel suffit à lancer l'audit d'un preset — typiquement depuis la CI, après un déploiement :

```bash
curl -X POST https://crowler.exemple.fr/api/hooks/run \
  -H "Authorization: Bearer $CROWLER_TOKEN" \
  -H "content-type: application/json" \
  -d '{"preset":"prod"}'
```

Le corps ne porte **que** le nom du preset. Ni l'URL ni les réglages ne sont surchargeables :
tout ce qui sera crawlé a été décidé dans l'interface, donc un jeton qui fuite ne permet pas de
viser un autre site. Le jeton se lit dans l'en-tête `Authorization` et nulle part ailleurs —
en query string il finirait dans les logs d'accès du proxy et dans l'historique du navigateur.

L'audit démarré est un audit comme les autres : il apparaît dans la barre de gauche, marqué du
nom de son preset, se suit en direct et s'exporte en CSV.

| Réponse | Signification |
|---|---|
| `200` `{"started":true,"id":"…"}` | crawl démarré ; `id` est celui de l'audit |
| `200` `{"started":false,"id":"…"}` | le crawl précédent de ce preset tourne encore, `id` est le sien |
| `401` `jeton ou preset invalide` | jeton faux, absent, ou preset inconnu — même message dans les trois cas |
| `429` + `Retry-After` | preset déclenché il y a moins de `WEBHOOK_MIN_INTERVAL` secondes |
| `403` / `400` | la cible du preset ne passe plus les gardes (réseau privé, URL ou motif invalide) |

Les deux réponses `200` rendent l'appel **idempotent** : une CI qui rejoue son étape ne lance pas
un second crawl. Exemple d'étape GitHub Actions, le jeton en secret de dépôt :

```yaml
- name: Auditer les liens après déploiement
  run: |
    curl -fsS -X POST https://crowler.exemple.fr/api/hooks/run \
      -H "Authorization: Bearer ${{ secrets.CROWLER_TOKEN }}" \
      -H "content-type: application/json" \
      -d '{"preset":"prod"}'
```

## Notifications Google Chat

Un preset qui porte une URL de webhook Google Chat poste deux cartes dans l'espace : une au
départ de l'audit, une à son bilan.

L'URL s'obtient dans l'espace Chat, menu de l'espace → *Applications et intégrations* →
*Webhooks* → *Ajouter un webhook*. Elle ressemble à
`https://chat.googleapis.com/v1/spaces/…/messages?key=…&token=…` et se colle telle quelle dans le
champ **Notification Google Chat** des réglages du preset.

La carte de départ dit le site, le preset et l'heure. Celle de fin ajoute le nombre d'URLs
explorées, la durée, le décompte des liens possiblement cassés, les cinq premiers avec leur
statut, et deux boutons de téléchargement : l'export des liens cassés et l'export complet.

**Un audit lancé à la main depuis l'interface ne notifie pas.** La notification accompagne le
déclenchement automatique — un post-déploiement qui appelle `/api/hooks/run` — pas le travail
interactif, où l'écran montre déjà tout.

Les boutons de téléchargement ont besoin de savoir sous quelle adresse le service est joignable :
c'est `DOMAINS`. Sans elle, la carte part quand même, sans les boutons. Un espace injoignable,
lent ou en erreur n'interrompt jamais un audit : l'échec part dans le journal du conteneur et le
crawl se termine normalement.

## Pendant le crawl

La barre de statuts sert aussi de barre de progression : la partie pleine correspond aux URLs
déjà réglées, réparties par classe de status, et la zone hachurée en mouvement à celles qui
restent en file. Le bandeau sous la barre donne le compte en cours, la file, les requêtes en
vol et le débit. Le titre de l'onglet suit la progression, ce qui reste lisible quand l'onglet
est en arrière-plan.

« Arrêter » coupe le crawl : les requêtes en vol sont annulées et la pause de politesse est
interrompue, donc l'arrêt ne dépend pas du délai configuré. Le bouton affiche un indicateur
d'attente le temps que les workers se démontent. Les URLs dont la requête a été annulée sont
marquées « arrêté » et ne comptent pas comme liens cassés — elles n'ont pas été vérifiées.

À la fin, une notification système annonce le nombre d'URLs explorées, le nombre de liens
cassés et la durée. Le navigateur demande l'autorisation au premier audit ; si elle est
refusée, le réglage se décoche de lui-même et l'indique. L'API `Notification` exige un contexte
sécurisé : elle fonctionne sur `localhost` et en HTTPS, mais pas derrière une adresse IP en
HTTP simple — le bandeau de progression reste dans tous les cas.

## Synthèse

À la fin du crawl, l'onglet « Synthèse » dresse cinq graphiques sur l'audit complet :

| Graphique | Ce qu'il montre |
|---|---|
| Statuts par rôle | une barre empilée par rôle — `page`, `asset`, `external` — pour situer la casse |
| URLs par profondeur | la forme du site en clics depuis le départ, la part cassée coiffant chaque colonne |
| Temps de réponse | la distribution des latences par paliers, avec p50, p90, p99 et le volume transféré |
| Domaines externes | les 8 domaines hors site les plus liés, et ce qui a échoué chez eux |
| Pages à corriger | les 8 pages qui contiennent le plus de liens cassés — la file de travail |

Les barres sont des `div` dimensionnés en pourcentage : pas de librairie de graphiques, donc
rien à installer et rien de plus à charger. Le nombre de nœuds dessinés est borné — paliers
fixes, classements tronqués à 8 — et le calcul, une passe unique sur les lignes, n'a lieu que
lorsque l'onglet est celui affiché : un crawl en cours ne paie rien pour lui. Sur 60 000 URLs,
la synthèse se calcule et se dessine en une cinquantaine de millisecondes.

Deux réserves de lecture. Les paliers de latence comptent toutes les réponses reçues, 404
comprises — un site qui répond vite ses erreurs paraît rapide. Et « Pages à corriger » compte
les referers échantillonnés, donc plafonnés à 20 par lien cassé ; la carte le signale dès qu'un
lien dépasse ce seuil, et `liens-casses.csv` porte le compte exact.

## SEO on-page

Chaque page HTML explorée porte un bloc `seo`, relevé dans la même passe de lecture que les
liens — le HTML n'est parcouru qu'une fois :

| Champ | Contenu |
|---|---|
| `title` / `titleLen` | le premier `<title>`, espaces normalisés / sa longueur réelle |
| `desc` / `descLen` | `meta name=description` / sa longueur réelle |
| `h1` / `h1Count` | le texte du premier `h1` / le nombre de `h1` de la page |
| `canonical` | `link rel=canonical`, résolue en absolu et normalisée, `""` si absente |
| `robots` | `meta robots`, `meta googlebot` et l'en-tête `X-Robots-Tag` fusionnés, en minuscules |
| `lang` | l'attribut `lang` de `<html>` |
| `words` | le nombre de mots du texte visible, approximatif |

Les chaînes sont plafonnées avant stockage — 300 caractères pour `title` et `h1`, 500 pour
`desc` — mais la longueur réelle est conservée à côté : un `title` de 900 caractères se
diagnostique sans être gardé en mémoire. À 200 000 pages, le bloc coûte environ 1 ko par page
HTML ; décocher « Relever les balises SEO » le supprime entièrement.

La canonique est **mise en file** : sans cela, le rapport dirait quelle URL la page déclare
canonique sans dire si cette URL répond. Elle est ajoutée sans referer, donc `ref_count` reste
le compte des vrais liens entrants et une canonique ne fait pas passer une page pour liée. Une
canonique hors domaine est relevée sans être suivie — sinon un simple attribut lâcherait le
crawl sur le site d'un tiers — et une canonique visée par une exclusion n'est pas requêtée non
plus : exclu veut dire jamais requêté.

Pour `robots`, seules sont retenues les directives qui s'appliquent à un robot d'indexation
générique : celles sans agent nommé (`noindex`, `nofollow`) et celles préfixées `googlebot:`.
`bingbot: noindex` est ignoré, et un préfixe d'agent porte sur les directives qui le suivent
dans la même valeur, comme Google le documente. Réserve : plusieurs en-têtes `X-Robots-Tag`
arrivent déjà concaténés par l'API Fetch, un préfixe du premier déborde donc sur le suivant.

`words` compte les transitions d'espace sur le texte du document, hors `script`, `style`,
`noscript`, `template` et `title`. C'est un ordre de grandeur — de quoi repérer les pages
vides ou trop minces, pas une mesure éditoriale.

Le bloc n'est présent que sur les pages HTML : les assets et les liens externes sont testés en
`HEAD` et n'ont rien à relever. Il n'apparaît ni dans les CSV ni dans l'interface pour
l'instant ; il est écrit dans `rows.jsonl` et servi par l'API. Comme le format est sans schéma,
les audits enregistrés avant cette version se relisent tels quels, sans clé `seo`.

## Sitemap et pages orphelines

Le sitemap est lu avant le premier `GET`, et ses URLs entrent dans le crawl comme points de
départ. Il est cherché dans cet ordre : l'URL forcée dans les réglages, sinon les lignes
`Sitemap:` de `robots.txt`, sinon `/sitemap.xml` sur l'origine de départ. `robots.txt` est lu
pour ses sitemaps même quand « Respecter robots.txt » est décoché — c'est là que les sites les
publient, et le lire ne revient pas à y obéir.

Le lecteur est dans `sitemap.ts`, sans dépendance, en flux par `HTMLRewriter` : `<loc>` et
`<lastmod>` sont des éléments inconnus pour un parseur HTML, mais leur texte est bien restitué,
donc un sitemap de 200 000 URLs ne passe jamais par un DOM ni par une chaîne entière.

| Cas | Traitement |
|---|---|
| `<urlset>` | une liste de pages, avec le `<lastmod>` s'il est présent |
| `<sitemapindex>` | suivi sur **un seul** niveau, 50 sous-sitemaps au plus |
| `.xml.gz` | décompressé par `DecompressionStream("gzip")`, reconnu aux octets magiques et non à l'extension ni au `content-type`, que les serveurs se trompent régulièrement |
| `&amp;` dans `<loc>` | décodé — les entités sont la règle dans un sitemap, et `HTMLRewriter` livre le texte source |
| `<![CDATA[…]]>` | déballé : le tokenizer HTML le rend comme un commentaire, pas comme du texte |
| `<image:loc>` | ignoré, seul `<loc>` est une page |

Bornes : 20 Mo par fichier après décompression, 200 000 URLs pour l'ensemble, 50 sous-sitemaps.
Un fichier illisible est signalé sans faire échouer les autres, et un index qui se pointe
lui-même n'est lu qu'une fois. Un sitemap est une entrée distante comme une autre : ses URLs
passent la même garde réseau privé que la cible du crawl, la même liste d'exclusions et les
mêmes règles `robots.txt` — une URL que le site publie et s'interdit à la fois apparaît donc au
rapport avec `error = robots`.

### Orphelines

Les URLs du sitemap sont ajoutées à profondeur 0 **sans referer**. Cela suffit à définir une
page orpheline, sans compteur supplémentaire :

```
orpheline = présente dans le sitemap  ET  ref_count == 0
```

Autrement dit : le site la publie, mais aucune de ses pages n'y mène. L'URL de départ est la
seule exemption — c'est par elle que le crawl est entré. L'onglet « Orphelines » les liste, et
la carte « Sitemap » de la synthèse met les quatre nombres côte à côte : déclarées, aussi liées,
orphelines, et les pages liées que le sitemap ne déclare pas.

Une URL du sitemap hors du domaine audité (le décalage apex/`www` en est la cause habituelle)
est testée mais pas explorée, comme n'importe quel lien externe.

## Exports

**`pages-<domaine>.csv`** — une ligne par URL :
`url, status, kind, depth, content_type, response_ms, bytes, redirect_to, error, ref_count, first_referer, in_sitemap, orphan, sitemap_lastmod`

**`liens-casses-<domaine>.csv`** — une ligne par *occurrence* de lien cassé, c'est-à-dire une
ligne par correction à faire :
`target_url, status, error, referer, anchor_text, target_kind, total_referers, referers_listed`

`status` vide signifie que l'URL n'a jamais reçu de réponse ; la colonne `error` dit pourquoi
(`timeout`, `robots`, `bad-url`, `private-host`, ou le message réseau).

## Comment ça marche

Les balises SEO suivent le même principe : `title`, `h1` et le compte de mots sont accumulés
au fil des morceaux de texte, dans des tampons bornés, jamais dans un DOM.

Les liens sont extraits avec `HTMLRewriter`, le parseur HTML natif de Bun (moteur lolhtml, en
Rust) : les `href` sont relevés pendant l'arrivée des octets, sans jamais construire de DOM. La
mémoire ne dépend donc pas de la taille des pages, seulement du nombre d'URLs trouvées.

Les pages HTML internes sont récupérées en `GET` et explorées ; les assets et les liens externes
sont seulement testés en `HEAD` (avec repli en `GET` pour les serveurs qui refusent `HEAD`). Les
redirections sont suivies en `redirect: "manual"`, pour les faire apparaître dans le rapport
avec leur cible, et une chaîne de redirections ne consomme pas le budget de profondeur.

Les referers sont collectés à l'unique endroit où une URL est mise en file, donc la déduplication
et les referers ne peuvent pas diverger. Une même URL cassée liée depuis 500 pages conserve un
échantillon de **20 referers** (`referers_listed`) mais un compteur exact
(`total_referers`) — sans quoi une seule 404 populaire ferait exploser la mémoire.

## Sécurité

Par défaut le service refuse les cibles sur loopback, RFC 1918, link-local, CGNAT et les
hostnames sans point, à la fois pour l'URL de départ et pour chaque lien découvert (une page
crawlée peut pointer vers `169.254.169.254`). Mettre `BLOCK_PRIVATE_IPS=0` pour auditer un site
sur un réseau privé.

Cette garde travaille sur le nom d'hôte, pas sur l'IP résolue : elle n'arrête pas un domaine
public qui résout volontairement vers une adresse privée (DNS rebinding). Ne pas exposer une
instance avec `BLOCK_PRIVATE_IPS=0` sur un réseau non maîtrisé.

Un preset est revalidé par ces mêmes gardes **à chaque déclenchement**, pas seulement à son
enregistrement : une cible acceptée hier peut avoir cessé de l'être.

**Seul `/api/hooks/run` est conçu pour être exposé.** Le reste de l'API — dont la création et la
suppression de presets — n'est pas authentifié, comme l'interface elle-même. Ce n'est pas une
asymétrie oubliée : qui atteint `/api/crawl` peut déjà lancer le crawl de son choix, donc lui
laisser émettre un jeton ne lui donne aucun pouvoir de plus. L'instance doit rester derrière un
réseau de confiance ou un reverse-proxy qui l'authentifie, en n'ouvrant que `/api/hooks/run`
sur l'extérieur.

L'URL d'un webhook Google Chat est un secret : elle contient sa clé et son jeton en query
string. Elle ne peut pas être hachée — il faut pouvoir la rejouer — donc elle est écrite en clair
dans `presets.json`, créé en `0600`. Elle n'est en revanche **jamais renvoyée par l'API** :
`GET /api/presets` n'en dit que l'existence, comme il tait l'empreinte des jetons. C'est pourquoi
l'interface ne peut pas la relire, seulement la remplacer ou la retirer.

Les jetons de webhook font 256 bits tirés au hasard et ne sont stockés que par leur empreinte
SHA-256 : le fichier `presets.json` ne permet pas de reconstituer un jeton. La comparaison est
à temps constant, et un preset inconnu coûte le même travail qu'un mauvais jeton — la durée de
la réponse ne révèle pas quels presets existent. Un plafond d'échecs d'authentification par IP
freine l'énumération de noms ; il ne prétend pas protéger le jeton lui-même, 256 bits n'en
demandent pas.

## Limites connues

- Les liens créés par JavaScript après le chargement ne sont pas vus : le crawler lit le HTML
  servi, il n'exécute pas de navigateur.
- `srcset` et `<meta http-equiv="refresh">` ne sont pas analysés.
- Les 5 derniers audits restent en mémoire pour le suivi en direct ; les autres sont relus
  depuis le disque, ce qui n'autorise plus l'arrêt ni la reprise du flux, seulement la lecture
  et l'export.
- Les lignes d'un audit ne sont écrites qu'à sa fin : un crawl coupé par l'arrêt du serveur ne
  laisse que son en-tête.
- Le corps d'une page est lu jusqu'à 8 Mo, au-delà il est tronqué (`body-truncated`) et les
  liens situées après ne sont pas relevés.

## Tests

```bash
bun test
```

78 tests sur un site fixture volontairement cassé : referers d'une 404 liée depuis deux pages,
absence de boucle sur un cycle A↔B, `<base href>`, redirections, plafonds de profondeur et de
pages, `robots.txt`, garde SSRF, normalisation d'URL, extraction SEO — plafonds, fusion de
`X-Robots-Tag`, canonique mise en file sans referer —, forme des deux CSV, aller-retour d'un
audit par le disque et refus des identifiants qui sortiraient du dossier de données. Côté
presets : jeton absent du fichier enregistré, rotation qui invalide l'ancien, mise à jour qui
préserve le jeton, noms hors format refusés, plafond, et cohabitation de `presets.json` avec
l'historique des audits. Côté notifications : dérivation de la base publique depuis `DOMAINS`,
forme des deux cartes, plafond et échappement des URLs cassées affichées, et un envoi qui ne lève
pas même quand l'espace répond 500 ou ne répond pas.
