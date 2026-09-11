/**
 * Presets de crawl : une cible et ses réglages, enregistrés sous un nom, pour
 * être rejoués d'un clic depuis l'interface ou déclenchés de l'extérieur par un
 * webhook — typiquement le déploiement d'un site qui vient auditer ses liens.
 *
 * Un seul fichier texte, `presets.json` à côté des dossiers d'audit : il se lit
 * avec `cat`, se sauvegarde avec `cp`, et n'impose ni base ni migration. Le
 * fichier ne porte jamais un jeton en clair, seulement son empreinte.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULTS, type Options } from "./crawler";

const ROOT = resolve(process.env.DATA_DIR ?? "./data");
const FILE = join(ROOT, "presets.json");
/** Dans l'esprit de MAX_EXCLUDES et MAX_SESSIONS : toute liste a un plafond. */
export const MAX_PRESETS = 25;
/** Le nom voyage dans une URL et dans l'interface : on le tient à l'ascii sobre. */
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

export type Preset = {
  name: string;
  /** URL de départ, validée à l'enregistrement comme celle d'un audit manuel. */
  url: string;
  opts: Options;
  /** SHA-256 hex du jeton. Le jeton lui-même n'est écrit nulle part. */
  tokenHash: string;
  /**
   * Webhook Google Chat prévenu au début et à la fin des audits déclenchés par
   * ce preset. Absent = pas de notification. Son URL porte ses secrets dans sa
   * query string : elle est écrite ici, jamais renvoyée par l'API.
   */
  chatUrl?: string;
  createdAt: number;
  rotatedAt: number;
};

/** Ce que voit l'interface : tout sauf les secrets. Du webhook Google Chat, elle
    n'apprend que son existence — assez pour proposer de le retirer. */
export type PublicPreset = Omit<Preset, "tokenHash" | "chatUrl"> & { chat: boolean };

export const validName = (n: unknown): n is string => typeof n === "string" && NAME.test(n);

const pub = ({ tokenHash: _t, chatUrl, ...rest }: Preset): PublicPreset => ({ ...rest, chat: !!chatUrl });

/*
 * SHA-256 nu, sans bcrypt ni argon2 : un jeton est 256 bits tirés au hasard, pas
 * un mot de passe. Il n'y a aucun espace de recherche à ralentir — un dérivateur
 * lent ne protégerait rien et coûterait une dépendance.
 */
const sha = (s: string) => createHash("sha256").update(s).digest();

/** Comparé quand le preset n'existe pas, pour que le temps de réponse ne le dise pas. */
const DUMMY = sha("preset inconnu");

function mint(): { token: string; hash: string } {
  const token = "whk_" + randomBytes(32).toString("base64url");
  return { token, hash: sha(token).toString("hex") };
}

/** Un fichier édité à la main ne doit pas casser le serveur : ce qui n'a pas la forme est ignoré. */
function shaped(p: unknown): p is Preset {
  const o = p as Record<string, unknown>;
  return (
    !!o &&
    validName(o.name) &&
    typeof o.url === "string" &&
    typeof o.tokenHash === "string" &&
    /^[0-9a-f]{64}$/.test(o.tokenHash) &&
    typeof o.opts === "object" &&
    o.opts !== null
  );
}

async function readAll(): Promise<Preset[]> {
  try {
    const raw = (await Bun.file(FILE).json()) as unknown;
    if (!Array.isArray(raw)) return [];
    // Les options sont complétées par les défauts : un preset enregistré avant
    // l'ajout d'un réglage reste utilisable.
    return raw.filter(shaped).map((p) => ({ ...p, opts: { ...DEFAULTS, ...p.opts } }));
  } catch {
    return []; // aucun preset encore enregistré
  }
}

/** Écriture atomique : un lecteur concurrent voit l'ancien fichier ou le nouveau, jamais un tronqué. */
async function writeAll(all: Preset[]): Promise<void> {
  await mkdir(ROOT, { recursive: true });
  const tmp = FILE + ".tmp";
  await writeFile(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
  await rename(tmp, FILE);
}

/*
 * Les écritures sont des lire-modifier-écrire : deux requêtes simultanées
 * perdraient une modification. Elles passent donc en file, une à la fois.
 */
let chain: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

export async function list(): Promise<PublicPreset[]> {
  return (await readAll()).map(pub);
}

export async function get(name: string): Promise<Preset | null> {
  if (!validName(name)) return null;
  return (await readAll()).find((p) => p.name === name) ?? null;
}

/**
 * Crée le preset, ou met à jour la cible et les réglages d'un preset existant.
 * Le jeton n'est renvoyé qu'à la création : une mise à jour ne doit pas casser
 * les webhooks déjà en place chez l'appelant.
 *
 * `chatUrl` vide conserve celui déjà enregistré : l'interface ne peut pas le
 * relire, elle ne peut donc pas le renvoyer. Pour l'enlever, voir `clearChat`.
 */
export function put(
  name: string,
  url: string,
  opts: Options,
  chatUrl?: string,
): Promise<{ preset: PublicPreset; token?: string } | { error: string }> {
  return locked(async () => {
    if (!validName(name)) return { error: "nom invalide : lettres, chiffres, tiret et souligné, 32 caractères max" };
    const all = await readAll();
    const i = all.findIndex((p) => p.name === name);
    if (i >= 0) {
      const next: Preset = { ...all[i]!, url, opts, ...(chatUrl ? { chatUrl } : {}) };
      all[i] = next;
      await writeAll(all);
      return { preset: pub(next) };
    }
    if (all.length >= MAX_PRESETS) return { error: `limite de ${MAX_PRESETS} presets atteinte` };
    const { token, hash } = mint();
    const now = Date.now();
    // La clé reste absente sans webhook : un presets.json n'a pas de champ vide.
    const chat = chatUrl ? { chatUrl } : {};
    const next: Preset = { name, url, opts, ...chat, tokenHash: hash, createdAt: now, rotatedAt: now };
    all.push(next);
    await writeAll(all);
    return { preset: pub(next), token };
  });
}

/** Nouveau jeton : l'ancien cesse immédiatement de fonctionner. */
export function rotate(name: string): Promise<string | null> {
  return locked(async () => {
    if (!validName(name)) return null;
    const all = await readAll();
    const i = all.findIndex((p) => p.name === name);
    if (i < 0) return null;
    const { token, hash } = mint();
    all[i] = { ...all[i]!, tokenHash: hash, rotatedAt: Date.now() };
    await writeAll(all);
    return token;
  });
}

/** Retire le webhook Google Chat sans toucher au reste du preset ni à son jeton. */
export function clearChat(name: string): Promise<boolean> {
  return locked(async () => {
    if (!validName(name)) return false;
    const all = await readAll();
    const i = all.findIndex((p) => p.name === name);
    if (i < 0) return false;
    const { chatUrl: _c, ...rest } = all[i]!;
    all[i] = rest;
    await writeAll(all);
    return true;
  });
}

export function remove(name: string): Promise<boolean> {
  return locked(async () => {
    if (!validName(name)) return false;
    const all = await readAll();
    const rest = all.filter((p) => p.name !== name);
    if (rest.length === all.length) return false;
    await writeAll(rest);
    return true;
  });
}

/**
 * Vérifie un couple (nom, jeton) en temps constant. Un preset inconnu et un
 * mauvais jeton coûtent le même travail et donnent le même résultat : la durée
 * de la réponse ne révèle pas quels presets existent.
 */
export async function verify(name: unknown, token: unknown): Promise<Preset | null> {
  const supplied = sha(typeof token === "string" ? token : "");
  const p = typeof name === "string" && validName(name) ? await get(name) : null;
  const expected = p ? Buffer.from(p.tokenHash, "hex") : DUMMY;
  // Deux empreintes SHA-256 : toujours 32 octets, timingSafeEqual ne peut pas lever.
  return timingSafeEqual(supplied, expected) && p ? p : null;
}
