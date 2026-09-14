import { afterAll, beforeAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Les routes, contre un site d'une page servi en processus. `server.ts` lit son
 * environnement au chargement : il est donc importé après l'avoir posé, sur un
 * DATA_DIR neuf et un port libre, comme les serveurs de `crawler.test.ts`.
 */
const dir = join(tmpdir(), "crowler-server-" + Math.random().toString(36).slice(2));
let api = "";
let site: ReturnType<typeof Bun.serve>;
let srv: { stop: (f?: boolean) => void };

beforeAll(async () => {
  site = Bun.serve({
    port: 0,
    fetch: () => new Response("<a href='/autre'>lien</a>", { headers: { "content-type": "text/html" } }),
  });
  process.env.DATA_DIR = dir;
  process.env.PORT = "0";
  process.env.BLOCK_PRIVATE_IPS = "0"; // le site de test vit sur la boucle locale
  const mod = (await import("./server?" + Math.random())) as typeof import("./server");
  srv = mod.server;
  api = `http://127.0.0.1:${mod.server.port}`;
});

afterAll(async () => {
  srv.stop(true);
  site.stop(true);
  delete process.env.DATA_DIR;
  delete process.env.PORT;
  await rm(dir, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  fetch(api + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("un crawl lancé par nom de preset prend sa cible, ses réglages et son étiquette", async () => {
  const target = `http://127.0.0.1:${site.port}/`;
  const saved = await (await post("/api/presets", {
    name: "prod",
    url: target,
    opts: { maxPages: 1, useSitemap: false, respectRobots: false },
  })).json();
  expect(saved.preset.name).toBe("prod");

  // Le corps ne porte que le nom : ni l'URL ni les réglages ne sont surchargeables.
  const res = await post("/api/crawl", { preset: "prod", url: "http://ailleurs.invalid/", opts: { maxPages: 999 } });
  expect(res.status).toBe(200);
  const started = await res.json();
  expect(started.start).toBe(target);
  expect(started.opts.maxPages).toBe(1);

  // L'audit porte le nom de son déclencheur : c'est ce qui regroupe les audits
  // d'un preset dans son espace.
  const sessions = await (await fetch(api + "/api/sessions")).json();
  expect(sessions.find((m: { id: string }) => m.id === started.id).preset).toBe("prod");
});

test("un preset inconnu ne lance rien", async () => {
  for (const name of ["fantome", "../../etc"]) {
    const res = await post("/api/crawl", { preset: name, url: "http://127.0.0.1/" });
    expect(res.status).toBe(404);
  }
});

/* Un clic dans l'interface ne doit pas poster dans l'espace Chat d'une équipe :
   la notification accompagne le déclenchement automatique, pas le travail
   interactif. Un espace d'essai compte ce qui lui arrive. */
test("le webhook notifie l’espace Chat, un lancement depuis l’interface non", async () => {
  let posts = 0;
  const space = Bun.serve({ port: 0, fetch: () => { posts++; return new Response("{}"); } });
  try {
    const created = await (await post("/api/presets", {
      name: "notif",
      url: `http://127.0.0.1:${site.port}/`,
      opts: { maxPages: 1, useSitemap: false, respectRobots: false },
      chatUrl: `http://127.0.0.1:${space.port}/`,
    })).json();

    await post("/api/crawl", { preset: "notif" });
    await Bun.sleep(150); // la carte de départ part sans await : on lui laisse le temps de ne pas partir
    expect(posts).toBe(0);

    await fetch(api + "/api/hooks/run", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${created.token}` },
      body: JSON.stringify({ preset: "notif" }),
    });
    for (let i = 0; i < 40 && posts === 0; i++) await Bun.sleep(25);
    expect(posts).toBeGreaterThan(0);
  } finally {
    space.stop(true);
  }
});
