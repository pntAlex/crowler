/**
 * Demo site with deliberate breakage, for trying the crawler locally.
 *   bun fixture.ts            # http://localhost:4000
 *   BLOCK_PRIVATE_IPS=0 bun server.ts
 */
const PORT = Number(process.env.FIXTURE_PORT ?? 4000);

const nav = `<nav>
  <a href="/">Accueil</a> · <a href="/catalogue">Catalogue</a> ·
  <a href="/blog">Blog</a> · <a href="/contact">Contact</a> ·
  <a href="/mentions-legales">Mentions légales</a>
</nav><hr>`;

const page = (title: string, body: string) =>
  new Response(
    `<!doctype html><html lang=fr><head><meta charset=utf-8><title>${title}</title>
     <link rel=stylesheet href=/assets/site.css><link rel=icon href=/assets/favicon.png></head>
     <body><h1>${title}</h1>${nav}${body}</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );

/** Deliberately: /soldes-privees is listed but linked from nowhere (an orphan),
    /promos-ete is listed and broken, and /produits/lit-clos is linked but absent. */
const SITEMAP = ["/", "/catalogue", "/blog", "/contact", "/mentions-legales",
  "/produits/lampe-arc", "/produits/fauteuil-lc4", "/produits/table-tulipe",
  "/soldes-privees", "/promos-ete"];

const xml = (body: string) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, {
    headers: { "content-type": "application/xml; charset=utf-8" },
  });

const routes: Record<string, () => Response | Promise<Response>> = {
  "/": () => page("Boutique de démonstration", `
    <p><a href="/produits/lampe-arc">Lampe Arc</a>, <a href="/produits/fauteuil-lc4">Fauteuil LC4</a>,
    <a href="/produits/table-tulipe">Table Tulipe</a>.</p>
    <p><a href="/produits/chaise-retiree">la chaise retirée du catalogue</a> —
    <a href="/promos-ete">promotions d'été</a></p>
    <p><a href="/ancienne-boutique">ancienne boutique</a> (redirige)</p>
    <p><a href="https://example.com/">un partenaire</a> ·
    <a href="https://ce-domaine-nexiste-vraiment-pas-42.fr/">un partenaire disparu</a></p>
    <img src="/assets/hero.jpg" alt=""><img src="/assets/banniere-2019.jpg" alt="">
    <script src="/assets/app.js"></script>`),
  "/catalogue": () => page("Catalogue", `
    <ul>
      <li><a href="/produits/lampe-arc">Lampe Arc</a></li>
      <li><a href="/produits/chaise-retiree">Chaise Ronchamp</a></li>
      <li><a href="/produits/table-tulipe">Table Tulipe</a></li>
      <li><a href="/catalogue/archives">Archives 2019</a></li>
    </ul>`),
  "/catalogue/archives": () => page("Archives 2019", `
    <p><a href="/produits/chaise-retiree">Chaise Ronchamp</a> ·
    <a href="/produits/lit-clos">Lit clos</a></p>`),
  "/blog": () => page("Blog", `
    <p><a href="/blog/choisir-son-fauteuil">Choisir son fauteuil</a> ·
    <a href="/blog/entretien-du-cuir">Entretien du cuir</a></p>`),
  "/blog/choisir-son-fauteuil": () => page("Choisir son fauteuil", `
    <p>Voir le <a href="/produits/fauteuil-lc4">Fauteuil LC4</a> ou
    <a href="/produits/chaise-retiree">la chaise Ronchamp</a>.</p>
    <p><a href="/guide-2018.pdf">Notre guide 2018</a></p>`),
  "/blog/entretien-du-cuir": () => page("Entretien du cuir", `
    <p><a href="/produits/kit-entretien">Kit d'entretien</a> ·
    <a href="/promos-ete">promotions</a></p>`),
  "/contact": () => page("Contact", `<p><a href="mailto:bonjour@exemple.fr">bonjour@exemple.fr</a></p>
    <p><a href="/espace-client" rel="nofollow">Espace client</a></p>`),
  "/mentions-legales": () => page("Mentions légales", "<p>Société de démonstration.</p>"),
  "/produits/lampe-arc": () => page("Lampe Arc", "<p>1962.</p>"),
  "/produits/fauteuil-lc4": () => page("Fauteuil LC4", "<p>1928.</p>"),
  "/produits/table-tulipe": () => page("Table Tulipe", "<p>1957. <a href='/produits/lit-clos'>Voir aussi</a></p>"),
  "/espace-client": () => page("Espace client", "<p>Privé.</p>"),
  "/ancienne-boutique": () => new Response(null, { status: 301, headers: { location: "/catalogue" } }),
  "/guide-2018.pdf": () => new Response("%PDF-1.4 fake", { headers: { "content-type": "application/pdf" } }),
  "/assets/site.css": () => new Response("body{font-family:system-ui;max-width:40em;margin:3em auto}", { headers: { "content-type": "text/css" } }),
  "/assets/app.js": () => new Response("// app", { headers: { "content-type": "text/javascript" } }),
  "/assets/hero.jpg": () => new Response("jpeg", { headers: { "content-type": "image/jpeg" } }),
  "/assets/favicon.png": () => new Response("png", { headers: { "content-type": "image/png" } }),
  "/robots.txt": () => new Response(
    `Sitemap: http://localhost:${PORT}/sitemap.xml\nUser-agent: *\nDisallow: /espace-client\n`,
    { headers: { "content-type": "text/plain" } }),
  // An index pointing at one gzipped sitemap: both paths get exercised.
  "/sitemap.xml": () => xml(
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
    `<sitemap><loc>http://localhost:${PORT}/sitemap-pages.xml.gz</loc></sitemap>` +
    `</sitemapindex>`),
  "/sitemap-pages.xml.gz": () => new Response(
    Bun.gzipSync(new TextEncoder().encode(
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
      SITEMAP.map((p) => `<url><loc>http://localhost:${PORT}${p}</loc><lastmod>2024-06-01</lastmod></url>`).join("") +
      `</urlset>`)),
    { headers: { "content-type": "application/gzip" } }),
  // Listed by the sitemap, linked by nothing: the orphan the audit should surface.
  "/soldes-privees": () => page("Soldes privées", "<p>Page non liée depuis le site.</p>"),
  // Deliberately broken: 404 (linked from several pages), 500, timeout.
  "/promos-ete": () => new Response("Erreur serveur", { status: 500, headers: { "content-type": "text/html" } }),
  // Genuinely slow, to exercise in-flight aborts and the timeout setting.
  "/produits/kit-entretien": async () => {
    await Bun.sleep(1200);
    return new Response("réponse lente", { headers: { "content-type": "text/html" } });
  },
};

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const p = new URL(req.url).pathname;
    const r = routes[p];
    if (r) return r();
    return new Response(`<h1>404</h1><p>${p}</p>`, { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
  },
});
console.log(`fixture → http://localhost:${server.port}`);
