import { afterAll, beforeAll, expect, test } from "bun:test";
import { compileExcludes, Crawl, isBroken, isPrivateHost, normalize, type Row } from "./crawler";
import { brokenRows } from "./report";
import { Robots } from "./robots";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Fixture site: a deliberately broken little website. */
const site: Record<string, { body?: string; status?: number; type?: string; loc?: string }> = {
  "/": {
    body: `<!doctype html><html><head><link rel=stylesheet href=/style.css></head><body>
      <a href="/a">page A</a>
      <a href="/missing">le lien mort</a>
      <a href="/redir">redirection</a>
      <a href="/nofollow" rel="nofollow">zone privée</a>
      <a href="/doc.pdf">brochure</a>
      <a href="/deep1">niveau 1</a>
      <a href="/base">base tag</a>
      <a href="EXTORIGIN/">site partenaire</a>
      <img src="EXTORIGIN/pixel-externe.png">
      <a href="mailto:a@b.fr">écrire</a>
      <a href="#ancre">haut de page</a>
      <a href="http://">href malformé</a>
      <a href="https://exemple.fr:999999/">port invalide</a>
      <img src="/img/logo.png">
    </body></html>`,
  },
  "/a": { body: `<a href="/b">page B</a> <a href="/missing">aussi cassé</a>` },
  "/b": { body: `<a href="/a">retour vers A</a>` },
  "/missing": { status: 404, body: "nope" },
  "/nofollow": { body: "secret" },
  "/redir": { status: 301, loc: "/a" },
  "/deep1": { body: `<a href="/deep2">niveau 2</a>` },
  "/deep2": { body: `<a href="/deep3">niveau 3</a>` },
  "/deep3": { body: "fond" },
  "/base": { body: `<html><head><base href="/sub/"></head><body><a href="x.html">relatif</a></body></html>` },
  "/sub/x.html": { body: "ok" },
  "/doc.pdf": { type: "application/pdf", body: `<a href="/piege">ne doit pas etre suivi</a>` },
  "/style.css": { type: "text/css", body: "body{}" },
};

let origin = "";
let extOrigin = "";
let server: ReturnType<typeof Bun.serve>;
let ext: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname;
      const page = site[p];
      if (!page) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
      if (page.loc) return new Response(null, { status: page.status ?? 301, headers: { location: page.loc } });
      return new Response(page.body ?? "", {
        status: page.status ?? 200,
        headers: { "content-type": page.type ?? "text/html; charset=utf-8" },
      });
    },
  });
  ext = Bun.serve({
    port: 0,
    fetch: () => new Response(`<a href="/interne-au-partenaire">ne doit pas etre crawlé</a>`, {
      headers: { "content-type": "text/html" },
    }),
  });
  origin = `http://127.0.0.1:${server.port}`;
  extOrigin = `http://localhost:${ext.port}`;
  // rewrite the placeholders now that the port is known
  site["/"]!.body = site["/"]!.body!.replaceAll("EXTORIGIN", extOrigin);
});

afterAll(() => {
  server.stop(true);
  ext.stop(true);
});

/** blockPrivate = false: the fixture lives on loopback. */
const crawl = async (opts = {}) => {
  const c = new Crawl(origin + "/", { respectRobots: false, timeoutMs: 2500, ...opts }, () => {}, false);
  await c.run();
  return c;
};
const at = (c: Crawl, path: string): Row | undefined => c.rows.get(origin + path);

test("relève le status de chaque page et termine sans boucler", async () => {
  const c = await crawl();
  expect(at(c, "/")!.status).toBe(200);
  expect(at(c, "/a")!.status).toBe(200);
  expect(at(c, "/b")!.status).toBe(200);
  expect(at(c, "/missing")!.status).toBe(404);
  // A <-> B is a cycle: each page must be fetched exactly once.
  expect(at(c, "/a")!.ms).toBeGreaterThanOrEqual(0);
  expect(c.stats().done).toBe(c.stats().total - countUnrequested(c));
});

const countUnrequested = (c: Crawl) => [...c.rows.values()].filter((r) => r.error === "bad-url" || r.error === "robots" || r.error === "private-host").length;

test("chaque 404 remonte tous ses referers avec le texte du lien", async () => {
  const c = await crawl();
  const miss = at(c, "/missing")!;
  expect(miss.refCount).toBe(2);
  const froms = miss.refs.map((r) => r.from).sort();
  expect(froms).toEqual([origin + "/", origin + "/a"]);
  expect(miss.refs.find((r) => r.from === origin + "/")!.text).toBe("le lien mort");
  expect(miss.refs.find((r) => r.from === origin + "/a")!.text).toBe("aussi cassé");
});

test("détecte un asset cassé et sa page source", async () => {
  const c = await crawl();
  const img = at(c, "/img/logo.png")!;
  expect(img.status).toBe(404);
  expect(img.kind).toBe("asset");
  expect(img.refs[0]!.from).toBe(origin + "/");
  expect(at(c, "/style.css")!.status).toBe(200);
});

test("enregistre la redirection et sa cible sans consommer la profondeur", async () => {
  const c = await crawl();
  const r = at(c, "/redir")!;
  expect(r.status).toBe(301);
  expect(r.redirect).toBe(origin + "/a");
  expect(at(c, "/a")!.depth).toBe(1); // reached via / at depth 1, not pushed to 2 by the redirect
});

test("applique <base href> pour résoudre les liens relatifs", async () => {
  const c = await crawl();
  expect(at(c, "/sub/x.html")).toBeDefined();
  expect(at(c, "/x.html")).toBeUndefined();
});

test("ne parse que le HTML : un PDF n'est pas exploré", async () => {
  const c = await crawl();
  expect(at(c, "/doc.pdf")!.status).toBe(200);
  expect(at(c, "/piege")).toBeUndefined();
});

test("ignore nofollow, mailto et les ancres par défaut", async () => {
  const c = await crawl();
  expect(at(c, "/nofollow")).toBeUndefined();
  expect([...c.rows.keys()].some((k) => k.startsWith("mailto:"))).toBe(false);
  expect(c.rows.has(origin + "/#ancre")).toBe(false);
  const withNofollow = await crawl({ followNofollow: true });
  expect(at(withNofollow, "/nofollow")!.status).toBe(200);
});

test("un href malformé est signalé comme lien cassé avec son referer", async () => {
  const c = await crawl();
  const bad = [...c.rows.values()].find((r) => r.error === "bad-url")!;
  expect(bad.refs[0]!.from).toBe(origin + "/");
});

test("vérifie un lien externe sans explorer le site externe", async () => {
  const c = await crawl();
  const e = c.rows.get(extOrigin + "/")!;
  expect(e.kind).toBe("external");
  expect(e.status).toBe(200);
  expect(c.rows.has(extOrigin + "/interne-au-partenaire")).toBe(false);
});

test("checkExternal désactivé bloque tout le hors-domaine, assets compris", async () => {
  const c = await crawl({ checkExternal: false });
  expect([...c.rows.keys()].filter((k) => k.startsWith(extOrigin))).toEqual([]);
  // les assets du domaine restent vérifiés
  expect(at(c, "/img/logo.png")!.status).toBe(404);
});

test("un asset hors domaine est classé external, pas asset", async () => {
  const c = await crawl();
  const img = c.rows.get(extOrigin + "/pixel-externe.png")!;
  expect(img.kind).toBe("external");
  expect(img.asset).toBe(true);
  expect(img.refs[0]!.from).toBe(origin + "/");
});

test("checkAssets désactivé bloque les assets externes sans toucher aux liens externes", async () => {
  const c = await crawl({ checkAssets: false });
  expect(c.rows.has(extOrigin + "/pixel-externe.png")).toBe(false);
  expect(c.rows.has(extOrigin + "/")).toBe(true);
});

test("maxDepth borne l'exploration", async () => {
  const c = await crawl({ maxDepth: 1 });
  expect(at(c, "/deep1")!.depth).toBe(1);
  expect(at(c, "/deep2")).toBeUndefined();
});

test("maxPages borne la mémoire", async () => {
  const c = await crawl({ maxPages: 3 });
  expect(c.rows.size).toBe(3);
  expect(c.stats().capped).toBeGreaterThan(0);
});

test("checkAssets et checkExternal désactivés réduisent le périmètre", async () => {
  const c = await crawl({ checkAssets: false, checkExternal: false });
  expect(at(c, "/img/logo.png")).toBeUndefined();
  expect(c.rows.has(extOrigin + "/")).toBe(false);
});

test("broken.csv produit une ligne par couple (cible, referer)", async () => {
  const c = await crawl();
  const rows = await Array.fromAsync(brokenRows(c.rows.values()));
  const miss = rows.filter((r) => r[0] === origin + "/missing");
  expect(miss.length).toBe(2);
  expect(miss.map((r) => r[3]).sort()).toEqual([origin + "/", origin + "/a"]);
  expect(rows.every((r) => r[1] !== 200)).toBe(true);
});

test("une URL encore en file n'est pas comptée comme cassée", () => {
  const base = { url: "u", kind: "page" as const, asset: false, depth: 0, ms: 0, bytes: 0, type: "", refs: [], refCount: 0 };
  expect(isBroken({ ...base, status: 0 })).toBe(false);              // découverte, pas encore requêtée
  expect(isBroken({ ...base, status: 0, error: "timeout" })).toBe(true);
  expect(isBroken({ ...base, status: 0, error: "aborted" })).toBe(false);  // arrêt manuel, pas un défaut
  expect(isBroken({ ...base, status: 404 })).toBe(true);
  expect(isBroken({ ...base, status: 200 })).toBe(false);
  expect(isBroken({ ...base, status: 301 })).toBe(false);
});

test("exclusion par regex : les URLs correspondantes ne sont jamais requêtées", async () => {
  const c = await crawl({ exclude: ["/deep", "\\.pdf$"] });
  expect(at(c, "/deep1")).toBeUndefined();
  expect(at(c, "/deep2")).toBeUndefined();
  expect(at(c, "/doc.pdf")).toBeUndefined();
  expect(c.stats().excluded).toBeGreaterThanOrEqual(2);
  // le reste du site est intact
  expect(at(c, "/a")!.status).toBe(200);
  expect(at(c, "/missing")!.status).toBe(404);
});

test("exclusion insensible à la casse, appliquée aussi aux assets", async () => {
  const c = await crawl({ exclude: ["/IMG/"] });
  expect(at(c, "/img/logo.png")).toBeUndefined();
  expect(at(c, "/style.css")!.status).toBe(200);
});

test("exclusion appliquée aux liens externes comme aux internes", async () => {
  const c = await crawl({ exclude: ["localhost"] });
  expect([...c.rows.keys()].filter((k) => k.startsWith(extOrigin))).toEqual([]);
});

test("compileExcludes rejette motif invalide, pathologique ou trop long", () => {
  expect(compileExcludes(["("]).errors).toHaveLength(1);
  expect(compileExcludes(["(a+)+b"]).errors).toHaveLength(1);   // backtracking catastrophique
  expect(compileExcludes(["x".repeat(400)]).errors).toHaveLength(1);
  const ok = compileExcludes(["/blog/", "\\.pdf$", "  "]);
  expect(ok.errors).toEqual([]);
  expect(ok.res).toHaveLength(2);                                // la ligne vide est ignorée
});

test("l'arrêt aboutit vite même avec un gros délai de politesse", async () => {
  const c = new Crawl(origin + "/", { respectRobots: false, delayMs: 5000, concurrency: 2, timeoutMs: 2500 }, () => {}, false);
  const run = c.run();
  await Bun.sleep(150);
  const t0 = performance.now();
  c.stop();
  await run;
  // sans attente interruptible, les workers dormaient jusqu'à 5 000 ms
  expect(performance.now() - t0).toBeLessThan(400);
  expect(c.reason).toBe("stopped");
});

test("normalize déduplique les query strings équivalentes", () => {
  const k = (u: string, ig = false) => normalize(new URL(u), ig);
  expect(k("http://x.fr/p?b=2&a=1")).toBe(k("http://x.fr/p?a=1&b=2"));
  expect(k("http://x.fr/p#top")).toBe("http://x.fr/p");
  expect(k("http://x.fr/p?a=1", true)).toBe("http://x.fr/p");
  expect(k("http://X.FR:80/p")).toBe("http://x.fr/p");
});

test("garde SSRF : réseaux privés et hostnames nus refusés", () => {
  for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1", "intranet", "fd00::1"])
    expect(isPrivateHost(h)).toBe(true);
  for (const h of ["exemple.fr", "8.8.8.8", "172.32.0.1", "www.a.co.uk"])
    expect(isPrivateHost(h)).toBe(false);
});

test("robots.txt : préfixe le plus long, wildcards et Allow prioritaire", () => {
  const r = new Robots();
  r.parse(`User-agent: *\nDisallow: /admin\nAllow: /admin/public\nDisallow: /*.json$\nCrawl-delay: 1`, "crowler/1.0");
  expect(r.allows("/")).toBe(true);
  expect(r.allows("/admin/secret")).toBe(false);
  expect(r.allows("/admin/public/page")).toBe(true);
  expect(r.allows("/data/a.json")).toBe(false);
  expect(r.allows("/data/a.json?x=1")).toBe(true);
  expect(r.crawlDelay).toBe(1000);
});

test("robots.txt : un groupe ciblant un autre agent est ignoré", () => {
  const r = new Robots();
  r.parse(`User-agent: BadBot\nDisallow: /\n\nUser-agent: *\nDisallow: /tmp`, "crowler/1.0");
  expect(r.allows("/")).toBe(true);
  expect(r.allows("/tmp/x")).toBe(false);
});

/* ---- persistance ---- */

test("un audit enregistré se relit à l'identique et s'exporte depuis le disque", async () => {
  const dir = join(tmpdir(), "crowler-test-" + Math.random().toString(36).slice(2));
  process.env.DATA_DIR = dir;
  try {
    const store = await import("./store?" + Math.random()) as typeof import("./store");
    const c = await crawl();

    await store.begin(c);
    let heads = await store.list();
    expect(heads.length).toBe(1);
    expect(heads[0]!.host).toBe(new URL(origin).hostname);

    await store.save(c);
    heads = await store.list();
    expect(heads[0]!.finishedAt).toBeGreaterThan(0);
    expect(heads[0]!.broken).toBe([...c.rows.values()].filter(isBroken).length);
    expect(heads[0]!.stats!.total).toBe(c.rows.size);

    // Les lignes relues portent la même information que celles en mémoire.
    const back = await Array.fromAsync(store.rows(c.id));
    expect(back.length).toBe(c.rows.size);
    const missing = back.find((r) => r.url === origin + "/missing")!;
    expect(missing.status).toBe(404);
    expect(missing.refs.map((f) => f.from).sort()).toEqual([origin + "/", origin + "/a"]);

    // Donc l'export d'un audit passé est identique à celui de l'audit en cours.
    const fromDisk = await Array.fromAsync(brokenRows(store.rows(c.id)));
    const fromMemory = await Array.fromAsync(brokenRows(c.rows.values()));
    expect(fromDisk).toEqual(fromMemory);

    expect(await store.remove(c.id)).toBe(true);
    expect(await store.list()).toEqual([]);
  } finally {
    delete process.env.DATA_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

test("un identifiant hors format ne sort pas du dossier de données", async () => {
  const dir = join(tmpdir(), "crowler-test-" + Math.random().toString(36).slice(2));
  process.env.DATA_DIR = dir;
  try {
    const store = await import("./store?" + Math.random()) as typeof import("./store");
    for (const bad of ["../etc", "a/b", ".", "", "a".repeat(64)]) {
      expect(await store.read(bad)).toBe(null);
      expect(await store.remove(bad)).toBe(false);
      expect(await Array.fromAsync(store.rows(bad))).toEqual([]);
    }
  } finally {
    delete process.env.DATA_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});
