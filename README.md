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
docker build -t crowler . && docker run -p 3000:3000 -v crowler-data:/app/data crowler
```

Le volume porte l'historique des audits : sans lui, recréer le conteneur repart d'une ardoise
vide. Image de 132 Mo, environ 60 Mo de RAM en usage.

| Variable | Défaut | Effet |
|---|---|---|
| `PORT` | 3000 | port d'écoute |
| `BLOCK_PRIVATE_IPS` | `1` dans l'image | refuse les cibles sur réseau privé |
| `DATA_DIR` | `./data`, `/app/data` dans l'image | où sont stockés les audits |
| `MAX_SESSIONS` | 50 | audits conservés ; au-delà, les plus anciens sont supprimés |

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

## Exports

**`pages-<domaine>.csv`** — une ligne par URL :
`url, status, kind, depth, content_type, response_ms, bytes, redirect_to, error, ref_count, first_referer`

**`liens-casses-<domaine>.csv`** — une ligne par *occurrence* de lien cassé, c'est-à-dire une
ligne par correction à faire :
`target_url, status, error, referer, anchor_text, target_kind, total_referers, referers_listed`

`status` vide signifie que l'URL n'a jamais reçu de réponse ; la colonne `error` dit pourquoi
(`timeout`, `robots`, `bad-url`, `private-host`, ou le message réseau).

## Comment ça marche

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

28 tests sur un site fixture volontairement cassé : referers d'une 404 liée depuis deux pages,
absence de boucle sur un cycle A↔B, `<base href>`, redirections, plafonds de profondeur et de
pages, `robots.txt`, garde SSRF, normalisation d'URL, forme des deux CSV, aller-retour d'un
audit par le disque et refus des identifiants qui sortiraient du dossier de données.
