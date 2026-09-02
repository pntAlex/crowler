/**
 * Persistance des audits, sans base de données : un dossier par crawl, deux
 * fichiers texte. `meta.json` porte l'entête (cible, réglages, statistiques),
 * `rows.jsonl` une URL auditée par ligne.
 *
 * Le format se lit avec `cat`, se filtre avec `grep`, se sauvegarde avec `cp`,
 * et n'impose ni schéma ni migration. Les lignes sont écrites et relues en flux,
 * donc un audit de 200 000 URLs ne passe jamais entier par la mémoire.
 */
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isBroken, type Crawl, type Options, type Row, type Stats } from "./crawler";

const ROOT = resolve(process.env.DATA_DIR ?? "./data");
/** Au-delà, les audits les plus anciens sont supprimés à la fin d'un crawl. */
const MAX_SESSIONS = Math.max(1, Number(process.env.MAX_SESSIONS ?? 50));
/** Les identifiants viennent de l'URL : tout ce qui n'est pas un id de crawl est refusé. */
const ID = /^[a-z0-9]{1,32}$/i;

export type Meta = {
  id: string;
  /** URL de départ, normalisée. */
  start: string;
  host: string;
  startedAt: number;
  /** 0 tant que le crawl tourne. */
  finishedAt: number;
  reason: string;
  opts: Options;
  stats: Stats | null;
  broken: number;
};

const dir = (id: string) => join(ROOT, id);
const valid = (id: string) => ID.test(id);

export function hostOf(url: string, fallback: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return fallback;
  }
}

export function metaOf(c: Crawl): Meta {
  let broken = 0;
  for (const r of c.rows.values()) if (isBroken(r)) broken++;
  return {
    id: c.id,
    start: c.start,
    host: hostOf(c.start, c.id),
    startedAt: c.startedAt,
    finishedAt: c.finishedAt,
    reason: c.reason,
    opts: c.opts,
    stats: c.stats(),
    broken,
  };
}

/** Écriture atomique : un lecteur concurrent voit l'ancien fichier ou le nouveau, jamais un fichier tronqué. */
async function writeAtomic(path: string, body: string) {
  const tmp = path + ".tmp";
  await writeFile(tmp, body);
  await rename(tmp, path);
}

/** Inscrit l'audit dès son démarrage : il apparaît dans l'historique pendant qu'il tourne. */
export async function begin(c: Crawl): Promise<void> {
  await mkdir(dir(c.id), { recursive: true });
  await writeAtomic(join(dir(c.id), "meta.json"), JSON.stringify(metaOf(c)));
}

/** Fige l'audit terminé : les lignes d'abord, l'entête ensuite. */
export async function save(c: Crawl): Promise<void> {
  const d = dir(c.id);
  await mkdir(d, { recursive: true });

  const tmp = join(d, "rows.jsonl.tmp");
  const w = Bun.file(tmp).writer();
  let n = 0;
  for (const r of c.rows.values()) {
    w.write(JSON.stringify(r) + "\n");
    // Vider régulièrement : le tampon du sink ne doit pas grossir avec le crawl.
    if (++n % 2000 === 0) await w.flush();
  }
  await w.end();
  await rename(tmp, join(d, "rows.jsonl"));

  // rows.jsonl est en place avant meta.json : un `finishedAt` non nul garantit
  // donc que les lignes sont lisibles.
  await writeAtomic(join(d, "meta.json"), JSON.stringify(metaOf(c)));
}

export async function read(id: string): Promise<Meta | null> {
  if (!valid(id)) return null;
  try {
    const m = (await Bun.file(join(dir(id), "meta.json")).json()) as Meta;
    return m && m.id === id ? m : null;
  } catch {
    return null;
  }
}

/** Les audits, du plus récent au plus ancien. */
export async function list(): Promise<Meta[]> {
  let names: string[];
  try {
    names = await readdir(ROOT);
  } catch {
    return []; // aucun audit encore enregistré
  }
  const out: Meta[] = [];
  for (const name of names) {
    const m = await read(name);
    if (m) out.push(m);
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

/** Les lignes d'un audit terminé, relues en flux ligne à ligne. */
export async function* rows(id: string): AsyncGenerator<Row> {
  if (!valid(id)) return;
  const f = Bun.file(join(dir(id), "rows.jsonl"));
  if (!(await f.exists())) return;
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of f.stream()) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line) yield JSON.parse(line) as Row;
    }
  }
  if (buf.trim()) yield JSON.parse(buf) as Row;
}

export async function remove(id: string): Promise<boolean> {
  if (!valid(id)) return false;
  try {
    await rm(dir(id), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** Borne l'historique. `keep` protège les audits encore en cours. */
export async function prune(keep: (id: string) => boolean): Promise<void> {
  const all = await list();
  for (const m of all.slice(MAX_SESSIONS)) {
    if (keep(m.id)) continue;
    await remove(m.id);
  }
}
