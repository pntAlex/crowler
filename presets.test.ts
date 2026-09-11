import { expect, test } from "bun:test";
import { rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "./crawler";

/**
 * DATA_DIR est lu au chargement du module : chaque test l'installe sur un
 * dossier neuf puis réimporte `presets` avec un suffixe unique, comme le font
 * déjà les tests de persistance dans crawler.test.ts.
 */
async function sandbox<T>(fn: (p: typeof import("./presets"), dir: string) => Promise<T>): Promise<T> {
  const dir = join(tmpdir(), "crowler-presets-" + Math.random().toString(36).slice(2));
  process.env.DATA_DIR = dir;
  try {
    return await fn((await import("./presets?" + Math.random())) as typeof import("./presets"), dir);
  } finally {
    delete process.env.DATA_DIR;
    await rm(dir, { recursive: true, force: true });
  }
}

const opts = (over: Partial<typeof DEFAULTS> = {}) => ({ ...DEFAULTS, ...over });

test("un preset créé rend son jeton une fois, et jamais le disque", async () => {
  await sandbox(async (presets, dir) => {
    const r = await presets.put("prod", "https://exemple.fr/", opts());
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.token).toMatch(/^whk_[A-Za-z0-9_-]{43}$/);
    expect(r.preset).not.toHaveProperty("tokenHash");

    // Le jeton en clair ne doit apparaître nulle part dans le fichier.
    const raw = await readFile(join(dir, "presets.json"), "utf8");
    expect(raw).not.toContain(r.token!);
    expect(raw).toMatch(/"tokenHash": "[0-9a-f]{64}"/);

    // La liste publique ne porte pas non plus l'empreinte.
    expect(await presets.list()).toEqual([r.preset]);
  });
});

test("verify accepte le bon jeton et refuse tout le reste de la même façon", async () => {
  await sandbox(async (presets) => {
    const r = await presets.put("prod", "https://exemple.fr/", opts());
    if ("error" in r) throw new Error(r.error);
    const token = r.token!;

    expect((await presets.verify("prod", token))?.name).toBe("prod");
    // Mauvais jeton, jeton vide, jeton d'une autre forme, preset inconnu :
    // toujours la même valeur de retour.
    expect(await presets.verify("prod", token.slice(0, -1) + "x")).toBe(null);
    expect(await presets.verify("prod", "")).toBe(null);
    expect(await presets.verify("prod", undefined)).toBe(null);
    expect(await presets.verify("inconnu", token)).toBe(null);
    expect(await presets.verify("../etc", token)).toBe(null);
  });
});

test("la rotation invalide l'ancien jeton", async () => {
  await sandbox(async (presets) => {
    const r = await presets.put("prod", "https://exemple.fr/", opts());
    if ("error" in r) throw new Error(r.error);
    const old = r.token!;

    const fresh = await presets.rotate("prod");
    expect(fresh).toMatch(/^whk_/);
    expect(fresh).not.toBe(old);
    expect(await presets.verify("prod", old)).toBe(null);
    expect((await presets.verify("prod", fresh!))?.name).toBe("prod");

    expect(await presets.rotate("inconnu")).toBe(null);
  });
});

test("mettre à jour un preset change ses réglages sans casser son jeton", async () => {
  await sandbox(async (presets) => {
    const first = await presets.put("prod", "https://exemple.fr/", opts({ maxPages: 100 }));
    if ("error" in first) throw new Error(first.error);
    const token = first.token!;

    const again = await presets.put("prod", "https://exemple.fr/blog", opts({ maxPages: 500 }));
    if ("error" in again) throw new Error(again.error);
    // Pas de nouveau jeton : les webhooks déjà déployés continuent de marcher.
    expect(again.token).toBeUndefined();
    expect(again.preset.url).toBe("https://exemple.fr/blog");
    expect(again.preset.opts.maxPages).toBe(500);
    expect((await presets.verify("prod", token))?.opts.maxPages).toBe(500);
    expect(await presets.list()).toHaveLength(1);
  });
});

test("un nom hors format est refusé", async () => {
  await sandbox(async (presets) => {
    for (const bad of ["", "../x", "a b", "-prod", "a".repeat(33), "presets.json", "pré"]) {
      expect(presets.validName(bad)).toBe(false);
      const r = await presets.put(bad, "https://exemple.fr/", opts());
      expect("error" in r).toBe(true);
      expect(await presets.remove(bad)).toBe(false);
    }
    expect(await presets.list()).toEqual([]);
  });
});

test("le nombre de presets est plafonné", async () => {
  await sandbox(async (presets) => {
    for (let i = 0; i < presets.MAX_PRESETS; i++) {
      const r = await presets.put("p" + i, "https://exemple.fr/", opts());
      expect("error" in r).toBe(false);
    }
    const over = await presets.put("un-de-trop", "https://exemple.fr/", opts());
    expect("error" in over).toBe(true);
    // Un preset existant reste modifiable une fois le plafond atteint.
    expect("error" in (await presets.put("p0", "https://exemple.fr/autre", opts()))).toBe(false);
    expect(await presets.list()).toHaveLength(presets.MAX_PRESETS);
  });
});

test("la suppression retire le preset et son jeton", async () => {
  await sandbox(async (presets) => {
    const r = await presets.put("prod", "https://exemple.fr/", opts());
    if ("error" in r) throw new Error(r.error);
    expect(await presets.remove("prod")).toBe(true);
    expect(await presets.remove("prod")).toBe(false);
    expect(await presets.verify("prod", r.token!)).toBe(null);
    expect(await presets.list()).toEqual([]);
  });
});

test("les presets survivent à un redémarrage, et un fichier abîmé ne casse rien", async () => {
  await sandbox(async (presets, dir) => {
    const r = await presets.put("prod", "https://exemple.fr/", opts({ concurrency: 3 }));
    if ("error" in r) throw new Error(r.error);

    // Réimport : le module relit le fichier, comme après un redémarrage.
    const again = (await import("./presets?" + Math.random())) as typeof import("./presets");
    expect((await again.verify("prod", r.token!))?.opts.concurrency).toBe(3);

    await Bun.write(join(dir, "presets.json"), '[{"name":"cassé"},null,42]');
    const broken = (await import("./presets?" + Math.random())) as typeof import("./presets");
    expect(await broken.list()).toEqual([]);
    expect(await broken.verify("cassé", r.token!)).toBe(null);
  });
});

test("presets.json cohabite avec les audits sans être pris pour l'un d'eux", async () => {
  await sandbox(async (presets, dir) => {
    await presets.put("prod", "https://exemple.fr/", opts());
    const store = (await import("./store?" + Math.random())) as typeof import("./store");

    // L'historique ne le voit pas, et la purge de l'historique ne l'efface pas.
    expect(await store.list()).toEqual([]);
    await store.prune(() => false);
    expect(await Bun.file(join(dir, "presets.json")).exists()).toBe(true);
    expect(await presets.list()).toHaveLength(1);
  });
});

test("l'URL de notification est enregistrée mais ne sort jamais par l'API", async () => {
  await sandbox(async (presets, dir) => {
    const url = "https://chat.googleapis.com/v1/spaces/AAA/messages?key=cle&token=jeton";
    const r = await presets.put("prod", "https://exemple.fr/", opts(), url);
    if ("error" in r) throw new Error(r.error);

    // L'interface n'apprend que son existence : de quoi proposer de la retirer.
    expect(r.preset).toEqual({ ...r.preset, chat: true });
    expect(r.preset).not.toHaveProperty("chatUrl");
    expect(JSON.stringify(await presets.list())).not.toContain("jeton");

    // Le serveur, lui, doit pouvoir la rejouer.
    expect((await presets.get("prod"))?.chatUrl).toBe(url);
    expect(await readFile(join(dir, "presets.json"), "utf8")).toContain(url);
  });
});

test("une mise à jour sans URL conserve la notification, clearChat la retire", async () => {
  await sandbox(async (presets) => {
    const url = "https://chat.googleapis.com/v1/spaces/AAA/messages?key=cle";
    await presets.put("prod", "https://exemple.fr/", opts(), url);

    // Le formulaire ne peut pas relire l'URL : réenregistrer ne doit pas la perdre.
    const maj = await presets.put("prod", "https://exemple.fr/blog", opts({ maxDepth: 2 }));
    if ("error" in maj) throw new Error(maj.error);
    expect(maj.preset.chat).toBe(true);
    expect((await presets.get("prod"))?.chatUrl).toBe(url);

    expect(await presets.clearChat("prod")).toBe(true);
    expect(await presets.clearChat("inconnu")).toBe(false);
    const apres = await presets.get("prod");
    expect(apres?.chatUrl).toBeUndefined();
    expect(apres?.opts.maxDepth).toBe(2); // le reste du preset n'a pas bougé
    expect((await presets.list())[0]!.chat).toBe(false);
  });
});

test("un preset enregistré avant la notification reste lisible", async () => {
  await sandbox(async (presets, dir) => {
    const r = await presets.put("prod", "https://exemple.fr/", opts());
    if ("error" in r) throw new Error(r.error);
    const raw = JSON.parse(await readFile(join(dir, "presets.json"), "utf8"));
    expect(raw[0]).not.toHaveProperty("chatUrl"); // pas de champ vide sur le disque

    const again = (await import("./presets?" + Math.random())) as typeof import("./presets");
    expect((await again.list())[0]!.chat).toBe(false);
    expect((await again.verify("prod", r.token!))?.chatUrl).toBeUndefined();
  });
});
