import { afterAll, beforeAll, expect, test } from "bun:test";
import { compileExcludes, Crawl, isBroken, isOrphan, isPrivateHost, normalize, wire, type Row } from "./crawler";
import { brokenRows, PAGES_HEADER, pagesRows } from "./report";
import { collect } from "./sitemap";
import { Robots } from "./robots";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Fixture site: a deliberately broken little website. */
const site: Record<string, { body?: string; status?: number; type?: string; loc?: string; head?: Record<string, string> }> = {
  "/": {
    body: `<!doctype html><html><head><link rel=stylesheet href=/style.css></head><body>
      <a href="/a">page A</a>
      <a href="/missing">le lien mort</a>
      <a href="/redir">redirection</a>
      <a href="/nofollow" rel="nofollow">zone privée</a>
      <a href="/doc.pdf">brochure</a>
      <a href="/deep1">niveau 1</a>
      <a href="/base">base tag</a>
      <a href="/seo">balises seo</a>
      <a href="/seo-entetes">seo par entete</a>
      <a href="/seo-long">seo verbeux</a>
      <a href="/seo-externe">canonique externe</a>
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
  "/b": { body: `<a href="/a">retour vers A</a> <a href="/aussi-listee">listée aussi</a>` },
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
  "/seo": {
    body: `<!doctype html><html lang="fr-FR"><head>
      <title>  Titre   de la page  </title>
      <meta name="Description" content="  Une description  parfaite. ">
      <meta name="robots" content="NoIndex, Follow">
      <link rel="Canonical" href="/seo-canonique">
      <style>.x{color:red}</style></head><body>
      <h1>Un <span>grand</span> titre</h1>
      <h1>doublon</h1>
      <p>un deux trois quatre</p>
      <script>var a = 1; var b = 2; var c = 3;</script>
      </body></html>`,
  },
  "/seo-canonique": { body: "<title>cible canonique</title>" },
  "/seo-entetes": {
    head: { "x-robots-tag": "noarchive, googlebot: nosnippet, bingbot: noindex" },
    body: `<html><head><meta name="robots" content="noindex"></head><body>page</body></html>`,
  },
  "/seo-long": {
    body: `<html><head><title>${"T".repeat(400)}</title>
      <meta name="description" content="${"d".repeat(700)}"></head><body>x</body></html>`,
  },
  "/seo-externe": {
    body: `<html><head><link rel="canonical" href="EXTORIGIN/canonique"></head><body>x</body></html>`,
  },
  /* ---- sitemap ----
     robots.txt declares the sitemap on its very first line, before any
     User-agent: the shape that used to be dropped on the floor. */
  "/robots.txt": { type: "text/plain", body: `Sitemap: ORIGIN/sitemap.xml\nUser-agent: *\nDisallow: /espace-prive\n` },
  "/sitemap.xml": {
    type: "application/xml",
    body: `<?xml version="1.0" encoding="UTF-8"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>ORIGIN/sitemap-pages.xml</loc></sitemap>
        <sitemap><loc>ORIGIN/sitemap-gz.xml.gz</loc></sitemap>
        <sitemap><loc>ORIGIN/sitemap-absent.xml</loc></sitemap>
      </sitemapindex>`,
  },
  "/sitemap-pages.xml": {
    type: "application/xml",
    body: `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
        <url><loc>ORIGIN/</loc><lastmod>2024-01-01</lastmod></url>
        <url><loc>ORIGIN/aussi-listee</loc></url>
        <url>
          <loc>ORIGIN/orpheline</loc><lastmod>2019-04-05T06:07:08+02:00</lastmod>
          <image:image><image:loc>ORIGIN/pas-une-page.png</image:loc></image:image>
        </url>
        <url><loc>ORIGIN/entite?b=2&amp;a=1</loc></url>
        <url><loc><![CDATA[ORIGIN/cdata]]></loc></url>
        <url><loc>ORIGIN/exclue-du-sitemap</loc></url>
        <url><loc>ORIGIN/espace-prive</loc></url>
      </urlset>`,
  },
  "/sitemap-absent.xml": { status: 404, body: "nope" },
  "/orpheline": { body: "aucun lien du site ne mene ici" },
  "/aussi-listee": { body: "listee et liee" },
  "/entite": { body: "entite decodee" },
  "/cdata": { body: "cdata deballe" },
  "/exclue-du-sitemap": { body: "ne doit jamais etre requetee" },
  "/espace-prive": { body: "interdite par robots.txt" },
  "/du-gz": { body: "venu du sitemap compresse" },
};

/** Only the sitemap points at /orpheline; /aussi-listee is both listed and linked. */
const GZ_SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
  <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>ORIGIN/du-gz</loc></url></urlset>`;

let origin = "";
let extOrigin = "";
let server: ReturnType<typeof Bun.serve>;
let ext: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === "/sitemap-gz.xml.gz") {
        return new Response(Bun.gzipSync(new TextEncoder().encode(GZ_SITEMAP.replaceAll("ORIGIN", origin))), {
          headers: { "content-type": "application/gzip" },
        });
      }
      const page = site[p];
      if (!page) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
      if (page.loc) return new Response(null, { status: page.status ?? 301, headers: { location: page.loc } });
      return new Response(page.body ?? "", {
        status: page.status ?? 200,
        headers: { "content-type": page.type ?? "text/html; charset=utf-8", ...page.head },
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
  // rewrite the placeholders now that the port is known — EXTORIGIN first,
  // otherwise ORIGIN would eat its tail.
  for (const page of Object.values(site)) {
    if (page.body) page.body = page.body.replaceAll("EXTORIGIN", extOrigin).replaceAll("ORIGIN", origin);
  }
});

afterAll(() => {
  server.stop(true);
  ext.stop(true);
});

/** blockPrivate = false: the fixture lives on loopback.
 *  The sitemap is off by default so each test states its own perimeter. */
const crawl = async (opts = {}) => {
  const c = new Crawl(origin + "/", { respectRobots: false, useSitemap: false, timeoutMs: 2500, ...opts }, () => {}, false);
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

/* ---- SEO ---- */

test("relève les balises SEO d'une page HTML", async () => {
  const seo = at(await crawl(), "/seo")!.seo!;
  expect(seo.title).toBe("Titre de la page");
  expect(seo.titleLen).toBe(16);
  expect(seo.desc).toBe("Une description parfaite.");
  expect(seo.descLen).toBe(25);
  expect(seo.h1).toBe("Un grand titre");   // le balisage imbriqué ne colle pas les mots
  expect(seo.h1Count).toBe(2);
  expect(seo.canonical).toBe(origin + "/seo-canonique");
  expect(seo.robots).toBe("noindex, follow");
  expect(seo.lang).toBe("fr-FR");
  // « Un grand titre » + « doublon » + « un deux trois quatre » ; script et style exclus
  expect(seo.words).toBe(8);
});

test("compte les mots d'une page sans balise body", async () => {
  const seo = at(await crawl(), "/a")!.seo!;
  expect(seo.words).toBe(4);
  expect(seo.title).toBe("");
  expect(seo.h1Count).toBe(0);
  expect(seo.canonical).toBe("");
});

test("la canonique est explorée sans compter comme lien entrant", async () => {
  const c = await crawl();
  const cible = at(c, "/seo-canonique")!;
  expect(cible.status).toBe(200);
  expect(cible.kind).toBe("page");
  expect(cible.refCount).toBe(0);   // une canonique est une déclaration, pas un lien
  expect(cible.refs).toEqual([]);
});

test("une canonique hors domaine est relevée sans être suivie", async () => {
  const c = await crawl();
  expect(at(c, "/seo-externe")!.seo!.canonical).toBe(extOrigin + "/canonique");
  expect(c.rows.has(extOrigin + "/canonique")).toBe(false);
});

test("une canonique exclue n'est pas requêtée", async () => {
  const c = await crawl({ exclude: ["/seo-canonique"] });
  expect(at(c, "/seo")!.seo!.canonical).toBe(origin + "/seo-canonique");
  expect(at(c, "/seo-canonique")).toBeUndefined();
});

test("X-Robots-Tag fusionné, hors directives adressées à un autre agent", async () => {
  const seo = at(await crawl(), "/seo-entetes")!.seo!;
  expect(seo.robots).toBe("noindex, noarchive, nosnippet");
});

test("les champs SEO sont plafonnés, la longueur réelle est conservée", async () => {
  const seo = at(await crawl(), "/seo-long")!.seo!;
  expect(seo.title.length).toBe(300);
  expect(seo.titleLen).toBe(400);
  expect(seo.desc.length).toBe(500);
  expect(seo.descLen).toBe(700);
});

test("SEO relevé sur les pages HTML seulement", async () => {
  const c = await crawl();
  expect(at(c, "/doc.pdf")!.seo).toBeUndefined();     // non-HTML
  expect(at(c, "/style.css")!.seo).toBeUndefined();   // asset, requêté en HEAD
  expect(c.rows.get(extOrigin + "/")!.seo).toBeUndefined();
});

test("collectSeo désactivé ne relève rien et ne met pas la canonique en file", async () => {
  const c = await crawl({ collectSeo: false });
  expect([...c.rows.values()].every((r) => r.seo === undefined)).toBe(true);
  expect(at(c, "/seo-canonique")).toBeUndefined();
});

test("wire n'ajoute la clé seo que si elle existe", async () => {
  const c = await crawl();
  expect((wire(at(c, "/seo")!) as { seo?: unknown }).seo).toBeDefined();
  expect((wire(at(c, "/style.css")!) as { seo?: unknown }).seo).toBeUndefined();
});

/* ---- sitemap ---- */

/** Le sitemap est la source de découverte, en plus des liens suivis. */
const withSitemap = (opts = {}) => crawl({ useSitemap: true, ...opts });

test("robots.txt : la ligne Sitemap est retenue, y compris avant tout User-agent", () => {
  const r = new Robots();
  r.parse(`Sitemap: https://exemple.fr/sitemap.xml\nUser-agent: *\nDisallow: /prive\nSitemap: https://exemple.fr/autre.xml`, "crowler/1.0");
  expect(r.sitemaps).toEqual(["https://exemple.fr/sitemap.xml", "https://exemple.fr/autre.xml"]);
  // La ligne Sitemap n'appartient à aucun groupe : elle ne doit pas en ouvrir un.
  expect(r.allows("/prive/x")).toBe(false);
});

test("robots.txt : une ligne Sitemap d'un autre groupe est retenue aussi", () => {
  const r = new Robots();
  r.parse(`User-agent: BadBot\nDisallow: /\nSitemap: https://exemple.fr/s.xml`, "crowler/1.0");
  expect(r.sitemaps).toEqual(["https://exemple.fr/s.xml"]);
  expect(r.allows("/")).toBe(true); // le groupe, lui, reste ignoré
});

test("le sitemap déclaré par robots.txt alimente le crawl, index et gzip compris", async () => {
  const c = await withSitemap();
  // /orpheline n'est liée par aucune page : seul le sitemap la fait connaître.
  expect(at(c, "/orpheline")!.status).toBe(200);
  expect(at(c, "/orpheline")!.inSitemap).toBe(true);
  expect(at(c, "/orpheline")!.depth).toBe(0);
  // suivie depuis l'index, après décompression gzip
  expect(at(c, "/du-gz")!.status).toBe(200);
  expect(at(c, "/du-gz")!.inSitemap).toBe(true);
  expect(c.sitemapSources).toContain(origin + "/sitemap-pages.xml");
  expect(c.sitemapSources).toContain(origin + "/sitemap-gz.xml.gz");
  // le sous-sitemap absent est signalé sans faire échouer les autres
  expect(c.sitemapErrors.join(" ")).toContain("sitemap-absent.xml");
});

test("les URLs du sitemap arrivent sans referer : ref_count reste le compte des vrais liens", async () => {
  const c = await withSitemap();
  expect(at(c, "/orpheline")!.refCount).toBe(0);
  expect(at(c, "/orpheline")!.refs).toEqual([]);
});

test("orpheline = listée par le sitemap, liée par personne ; le départ ne compte pas", async () => {
  const c = await withSitemap();
  expect(isOrphan(at(c, "/orpheline")!)).toBe(true);
  // listée ET liée depuis /b : le lien entrant lui retire son statut d'orpheline
  expect(at(c, "/aussi-listee")!.inSitemap).toBe(true);
  expect(at(c, "/aussi-listee")!.refCount).toBe(1);
  expect(isOrphan(at(c, "/aussi-listee")!)).toBe(false);
  // le point de départ est dans le sitemap et n'a aucun lien entrant : pas orphelin
  expect(at(c, "/")!.inSitemap).toBe(true);
  expect(at(c, "/")!.refCount).toBe(0);
  expect(isOrphan(at(c, "/")!)).toBe(false);
  // une page trouvée en suivant les liens, absente du sitemap, n'est pas orpheline
  expect(at(c, "/deep1")!.inSitemap).toBeUndefined();
  expect(isOrphan(at(c, "/deep1")!)).toBe(false);
});

test("le compteur d'orphelines suit les liens découverts en cours de route", async () => {
  const c = await withSitemap();
  const counted = [...c.rows.values()].filter(isOrphan).length;
  expect(c.stats().orphans).toBe(counted);
  expect(counted).toBeGreaterThan(0);
  expect(c.stats().sitemap).toBe(c.sitemapUrls.size);
  // /aussi-listee était orpheline à l'ajout ; le lien de /b l'a décomptée.
  expect(c.sitemapUrls.has(origin + "/aussi-listee")).toBe(true);
});

test("entités et CDATA dans <loc> sont décodées", async () => {
  const c = await withSitemap();
  expect(at(c, "/cdata")!.status).toBe(200);
  // &amp; devient &, puis normalize trie la query
  expect(at(c, "/entite?a=1&b=2")!.status).toBe(200);
});

test("lastmod du sitemap est conservé tel quel", async () => {
  const c = await withSitemap();
  expect(at(c, "/orpheline")!.lastmod).toBe("2019-04-05T06:07:08+02:00");
  expect(at(c, "/")!.lastmod).toBe("2024-01-01");
  expect(at(c, "/aussi-listee")!.lastmod).toBeUndefined(); // pas de lastmod déclaré
});

test("useSitemap désactivé n'ajoute rien", async () => {
  const c = await crawl();
  expect(at(c, "/orpheline")).toBeUndefined();
  expect(at(c, "/du-gz")).toBeUndefined();
  expect(c.stats().sitemap).toBe(0);
  expect(c.stats().orphans).toBe(0);
});

test("sitemapUrl force la source et court-circuite robots.txt", async () => {
  const c = await withSitemap({ sitemapUrl: origin + "/sitemap-gz.xml.gz" });
  expect(at(c, "/du-gz")!.status).toBe(200);
  expect(at(c, "/orpheline")).toBeUndefined(); // l'autre sous-sitemap n'a pas été lu
  expect(c.sitemapSources).toEqual([origin + "/sitemap-gz.xml.gz"]);
});

test("une exclusion s'applique aussi aux URLs du sitemap", async () => {
  const c = await withSitemap({ exclude: ["/exclue-du-sitemap"] });
  expect(at(c, "/exclue-du-sitemap")).toBeUndefined();
  // comptée comme déclarée, mais jamais requêtée
  expect(c.sitemapUrls.has(origin + "/exclue-du-sitemap")).toBe(true);
  expect(at(c, "/orpheline")!.status).toBe(200);
});

test("une URL du sitemap interdite par robots.txt est relevée, pas requêtée", async () => {
  const c = await withSitemap({ respectRobots: true });
  // Le défaut vaut d'être signalé : le site publie une URL qu'il s'interdit.
  const p = at(c, "/espace-prive")!;
  expect(p.inSitemap).toBe(true);
  expect(p.error).toBe("robots");
  expect(p.status).toBe(0);
  expect(isBroken(p)).toBe(true);
});

test("wire expose l'appartenance au sitemap et l'orphelinat", async () => {
  const c = await withSitemap();
  const orph = wire(at(c, "/orpheline")!) as Record<string, unknown>;
  expect(orph.sm).toBe(1);
  expect(orph.or).toBe(1);
  const liee = wire(at(c, "/aussi-listee")!) as Record<string, unknown>;
  expect(liee.sm).toBe(1);
  expect(liee.or).toBeUndefined();
  expect((wire(at(c, "/deep1")!) as Record<string, unknown>).sm).toBeUndefined();
});

test("pages.csv porte les colonnes sitemap", async () => {
  const c = await withSitemap();
  const i = { sm: PAGES_HEADER.indexOf("in_sitemap"), or: PAGES_HEADER.indexOf("orphan"), lm: PAGES_HEADER.indexOf("sitemap_lastmod") };
  const csv = await Array.fromAsync(pagesRows(c.rows.values()));
  const line = (u: string) => csv.find((r) => r[0] === origin + u)!;
  expect(line("/orpheline")[i.sm]).toBe(1);
  expect(line("/orpheline")[i.or]).toBe(1);
  expect(line("/orpheline")[i.lm]).toBe("2019-04-05T06:07:08+02:00");
  expect(line("/aussi-listee")[i.or]).toBe(0);
  expect(line("/deep1")[i.sm]).toBe(0);
});

test("collect : caps, boucles et cibles refusées ne font pas dérailler la lecture", async () => {
  // Un index qui se pointe lui-même ne doit pas boucler.
  const boucle = Bun.serve({
    port: 0,
    fetch: (req) => {
      const self = `http://127.0.0.1:${boucle.port}/s.xml`;
      return new Response(
        `<sitemapindex><sitemap><loc>${self}</loc></sitemap></sitemapindex>`,
        { headers: { "content-type": "application/xml" } },
      );
    },
  });
  try {
    const r = await collect([`http://127.0.0.1:${boucle.port}/s.xml`], { ua: "T/1", timeoutMs: 2000 });
    expect(r.urls).toEqual([]);
    expect(r.sources.length).toBe(1); // lu une seule fois
  } finally {
    boucle.stop(true);
  }

  // La garde SSRF est appliquée avant la requête, pas après.
  const refuse = await collect(["http://169.254.169.254/sitemap.xml"], {
    ua: "T/1",
    allow: (u) => !isPrivateHost(u.hostname),
  });
  expect(refuse.sources).toEqual([]);
  expect(refuse.errors.join(" ")).toContain("refusée");
});

test("collect : une redirection ne fait pas franchir la garde réseau privé", async () => {
  // Le piège : la cible passe la garde, sa redirection non. Suivre les
  // redirections avec `redirect: "follow"` aurait laissé passer la seconde.
  const piege = Bun.serve({
    port: 0,
    fetch: () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/interne.xml" } }),
  });
  try {
    const r = await collect([`http://127.0.0.1:${piege.port}/s.xml`], {
      ua: "T/1",
      timeoutMs: 2000,
      allow: (u) => u.hostname === "127.0.0.1",
    });
    expect(r.urls).toEqual([]);
    expect(r.sources).toEqual([]);
    expect(r.errors.join(" ")).toContain("refusée");
  } finally {
    piege.stop(true);
  }
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
    expect(back.find((r) => r.url === origin + "/seo")!.seo!.title).toBe("Titre de la page");

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
