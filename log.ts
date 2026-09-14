/**
 * Journal du serveur. Une ligne par événement sur stdout, et la même ligne
 * renvoyée à l'appelant pour qu'il la pousse vers l'interface (voir `Crawl.say`).
 *
 * Pas de fichier ni de rotation ici : le processus n'écrit que dans DATA_DIR et
 * la rotation est celle du conteneur (voir `logging` dans compose.yaml). Un
 * journal qu'on n'a pas à purger soi-même est un journal qui ne sature rien.
 */
export type Level = "debug" | "info" | "warn" | "error";
export type Line = { at: number; lvl: Level; msg: string };

const ORDER: Level[] = ["debug", "info", "warn", "error"];
/** Seuil relu à chaque ligne : un LOG_LEVEL changé prend effet sans redémarrage,
    et les tests peuvent le poser sans dépendre de l'ordre des imports.
    `silent` n'est pas un niveau de ligne, c'est le seuil qui les coupe toutes ;
    un niveau inconnu retombe sur `info` plutôt que de tout ouvrir. */
function min(): number {
  const v = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info");
  if (v === "silent") return ORDER.length;
  const i = ORDER.indexOf(v as Level);
  return i < 0 ? 1 : i;
}

/** Écrit la ligne, ou rend `null` si le niveau la filtre — l'appelant sait
    alors qu'il n'a rien à diffuser non plus. */
export function log(lvl: Level, msg: string, tag = ""): Line | null {
  if (ORDER.indexOf(lvl) < min()) return null;
  const line = { at: Date.now(), lvl, msg };
  // Le tag n'est que pour stdout : l'interface n'affiche que le crawl ouvert,
  // elle n'a pas à relire son propre identifiant à chaque ligne.
  console.log(`${new Date(line.at).toISOString()} ${lvl.toUpperCase().padEnd(5)} ${tag ? tag + " " : ""}${msg}`);
  return line;
}

/** Message d'une exception, sans la pile : un journal se lit, il ne se débogue pas. */
export const why = (e: unknown) => (e instanceof Error ? e.message : String(e));
