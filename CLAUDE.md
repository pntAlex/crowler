# Guidelines du projet

Ces règles priment sur les habitudes par défaut. Elles expliquent pourquoi le code a la
forme qu'il a, et ce qu'une contribution doit préserver.

## Zéro dépendance

`package.json` n'a ni `dependencies` ni `devDependencies`, il n'y a pas de lockfile, pas de
`node_modules`, pas d'étape de build. Tout passe par les primitives du runtime Bun
(`Bun.serve`, `Bun.file`, `HTMLRewriter`, `DecompressionStream`, `bun:test`) et par `node:*`.

Ajouter une dépendance est un changement d'architecture, pas un détail d'implémentation :
c'est une décision à poser explicitement, pas à glisser dans un commit de fonctionnalité.

## Simple et exploitable

- Modules plats à la racine, un rôle par fichier : `crawler.ts` explore, `store.ts` persiste,
  `presets.ts` enregistre les réglages nommés, `server.ts` expose, `report.ts` et `csv.ts`
  exportent. Un fichier qui grossit se scinde, il ne se met pas dans un dossier.
- Pas de base de données. La persistance est en fichiers texte lisibles avec `cat`, filtrables
  avec `grep`, sauvegardables avec `cp` : un dossier par audit, `presets.json` à côté. Aucun
  schéma, aucune migration.
- L'interface est un seul HTML sans framework ni build : CSS et JS en ligne, rendu par
  concaténation de chaînes échappées. Un `<script>` de plus ne se justifie pas.
- Le format des données reste tolérant : un champ absent est un champ absent, pas une erreur.
  Un enregistrement écrit avant l'ajout d'un réglage doit rester lisible après.

## Performance sans céder sur la sécurité

- Flux plutôt que tampons : lignes lues et écrites une par une, corps HTML analysé pendant
  qu'il arrive. La mémoire ne doit pas dépendre de la taille des pages.
- Toute liste a un plafond explicite, nommé en constante : `MAX_PAGES`, `MAX_EXCLUDES`,
  `MAX_SESSIONS`, `MAX_PRESETS`, `REF_CAP`, `MAX_BODY`. Une donnée venue de l'extérieur ne
  fait jamais grossir une structure sans borne.
- Toute entrée externe est validée et bornée **avant** usage, pas au moment où elle sert.
- La garde SSRF vaut pour l'URL de départ **et** pour chaque URL découverte : une page crawlée
  peut pointer vers un service interne. Elle est refaite à chaque démarrage de crawl, y compris
  pour un preset validé la veille.
- Les secrets ne sont jamais écrits en clair, ne transitent jamais par une URL, et se comparent
  en temps constant. Un message d'échec d'authentification ne dit pas *ce qui* a échoué.
- Le niveau attendu est celui d'un service exposé : les raccourcis « ça tourne en local » ne
  sont pas des arguments.

## Le strict nécessaire

On écrit le code que la fonctionnalité demande, pas celui qu'elle pourrait demander. Pas
d'abstraction pour un seul appelant, pas d'option de configuration sans usage, pas de couche
d'indirection « au cas où ». Un chemin de code en double est un bug à venir : on l'extrait
(`check()` et `launch()` dans `server.ts`, `readOpts()` dans l'interface) plutôt que de le
laisser diverger.

## Style

- **Les commentaires sont en français.** Ils disent *pourquoi*, jamais *quoi* : la ligne
  au-dessus dit déjà ce qu'elle fait. Un choix contre-intuitif se commente, sinon il sera
  « corrigé » plus tard.
- Les messages destinés à l'utilisateur — erreurs d'API, textes de l'interface — sont en
  français eux aussi.
- **Le français s'écrit accentué, partout.** Commentaires, messages, README, `compose.yaml`,
  `Dockerfile`, données de test : « réglable », pas « reglable ». Un accent oublié n'est pas
  une coquille anodine, il rend le texte étranger au reste du fichier. Les identifiants du
  code — noms de variables, de fonctions, clés JSON — restent eux sans accent.

## Tests

```bash
bun test
```

Les tests tournent contre le site volontairement cassé de `fixture.ts`, en processus, sans
réseau externe. Une correction de bug arrive avec le test qui l'aurait attrapée.
