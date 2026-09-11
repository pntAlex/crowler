import * as chat from "./chat";
import {
  compileExcludes, Crawl, DEFAULTS, isBroken, isPrivateHost, matchExclude, MAX_EXCLUDES,
  normalize, wire, type Options, type Row,
} from "./crawler";
import { csvResponse } from "./csv";
import * as presets from "./presets";
import { BROKEN_HEADER, brokenRows, PAGES_HEADER, pagesRows } from "./report";
import * as store from "./store";

const PORT = Number(process.env.PORT ?? 3000);
const BLOCK_PRIVATE = process.env.BLOCK_PRIVATE_IPS !== "0";
const MAX_JOBS = 5;
/** Délai minimum entre deux crawls d'un même preset, côté webhook. */
const HOOK_MIN_INTERVAL = Math.max(0, Number(process.env.WEBHOOK_MIN_INTERVAL ?? 60)) * 1000;
const MAX_HOOK_BODY = 4 * 1024;
/** Base des liens de téléchargement mis dans les notifications. DOMAINS sert
    d'abord aux labels Caddy ; vide, la carte part simplement sans boutons. */
const PUBLIC_BASE = chat.publicBase(process.env.DOMAINS);
const FAIL_WINDOW = 60_000;
const FAIL_MAX = 20;
const INDEX = Bun.file(new URL("./public/index.html", import.meta.url).pathname);

type Sub = (chunk: string) => void;
type Job = { crawl: Crawl; subs: Set<Sub>; preset?: string };

const jobs = new Map<string, Job>();

/** Only the *live* view of a crawl is capped: the audit itself stays on disk. */
function gc() {
  for (const [id, job] of jobs) {
    if (jobs.size <= MAX_JOBS) break;
    if (job.crawl.running) continue;
    for (const s of job.subs) s("event: gone\ndata: {}\n\n");
    jobs.delete(id);
  }
}

const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

function clampOpts(raw: unknown): Options {
  const o = (raw ?? {}) as Record<string, unknown>;
  const num = (k: keyof Options, lo: number, hi: number) => {
    const v = Number(o[k]);
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.trunc(v))) : (DEFAULTS[k] as number);
  };
  const bool = (k: keyof Options) => (typeof o[k] === "boolean" ? (o[k] as boolean) : (DEFAULTS[k] as boolean));
  const exclude = Array.isArray(o.exclude)
    ? (o.exclude as unknown[])
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim())
        .filter(Boolean)
        .slice(0, MAX_EXCLUDES)
    : [];
  return {
    exclude,
    checkExternal: bool("checkExternal"),
    checkAssets: bool("checkAssets"),
    respectRobots: bool("respectRobots"),
    includeSubdomains: bool("includeSubdomains"),
    followNofollow: bool("followNofollow"),
    ignoreQuery: bool("ignoreQuery"),
    collectSeo: bool("collectSeo"),
    useSitemap: bool("useSitemap"),
    sitemapUrl: typeof o.sitemapUrl === "string" ? o.sitemapUrl.trim().slice(0, 2048) : "",
    concurrency: num("concurrency", 1, 64),
    delayMs: num("delayMs", 0, 10_000),
    maxDepth: num("maxDepth", 0, 50),
    maxPages: num("maxPages", 1, 200_000),
    timeoutMs: num("timeoutMs", 1000, 120_000),
  };
}

const bad = (msg: string, code = 400) => Response.json({ error: msg }, { status: code });

function job(req: { params: { id: string } }): Job | null {
  return jobs.get(req.params.id) ?? null;
}

// ---- démarrage d'un crawl --------------------------------------------------

type Checked = { target: URL; opts: Options };
type Refused = { error: string; code: number };
const refused = (v: Checked | Refused): v is Refused => "error" in v;

/**
 * Les gardes communes à tout démarrage de crawl, quelle que soit son origine :
 * interface, enregistrement d'un preset ou webhook passent tous par ici. Une
 * cible validée hier peut avoir cessé de l'être : un preset est donc revérifié
 * à chaque déclenchement, pas seulement à son enregistrement.
 */
function check(rawUrl: unknown, rawOpts: unknown): Checked | Refused {
  let target: URL;
  try {
    target = new URL(String(rawUrl ?? "").trim());
  } catch {
    return { error: "URL invalide", code: 400 };
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return { error: "seuls http et https sont acceptés", code: 400 };
  }
  if (BLOCK_PRIVATE && isPrivateHost(target.hostname)) {
    return { error: "cible sur réseau privé refusée (BLOCK_PRIVATE_IPS=0 pour l'autoriser)", code: 403 };
  }

  const opts = clampOpts(rawOpts);
  // Le sitemap forcé est requêté par le crawler comme n'importe quelle autre
  // cible : il passe donc les deux mêmes gardes que l'URL de départ.
  if (opts.sitemapUrl) {
    let sm: URL;
    try {
      sm = new URL(opts.sitemapUrl);
    } catch {
      return { error: "URL de sitemap invalide", code: 400 };
    }
    if (sm.protocol !== "http:" && sm.protocol !== "https:") {
      return { error: "sitemap : seuls http et https sont acceptés", code: 400 };
    }
    if (BLOCK_PRIVATE && isPrivateHost(sm.hostname)) return { error: "sitemap sur réseau privé refusé", code: 403 };
  }
  const { res: excludes, errors } = compileExcludes(opts.exclude);
  if (errors.length) return { error: "exclusion : " + errors.join(" ; "), code: 400 };
  // Démarrer dans une zone exclue est une demande contradictoire : on le dit,
  // plutôt que de produire un audit d'une seule page.
  const seedKey = normalize(new URL(target.href), opts.ignoreQuery);
  const hit = matchExclude(seedKey, excludes);
  if (hit) return { error: `l'URL de départ est exclue par le motif /${hit.source}/`, code: 400 };
  return { target, opts };
}

/**
 * Même traitement que le sitemap forcé : cette URL vient de l'extérieur et c'est
 * le serveur qui la requêtera. Elle passe donc les mêmes gardes, à
 * l'enregistrement du preset comme à chaque déclenchement. Ne rien saisir n'est
 * pas une faute : la chaîne vide veut dire « pas de notification ».
 */
function safeChatUrl(raw: unknown): string | Refused {
  const s = typeof raw === "string" ? raw.trim().slice(0, 2048) : "";
  if (!s) return "";
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { error: "URL de notification invalide", code: 400 };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { error: "notification : seuls http et https sont acceptés", code: 400 };
  }
  if (BLOCK_PRIVATE && isPrivateHost(u.hostname)) {
    return { error: "notification sur réseau privé refusée", code: 403 };
  }
  return s;
}

/** Démarre le crawl validé et le branche sur le flux SSE et sur le disque. */
async function launch({ target, opts }: Checked, preset?: presets.Preset): Promise<Crawl> {
  const subs = new Set<Sub>();
  const crawl = new Crawl(
    target.href,
    opts,
    (e) => {
      if (e.type === "batch" && (e.rows as unknown[]).length === 0 && subs.size === 0) return;
      const chunk = frame(e);
      for (const s of subs) s(chunk);
    },
    BLOCK_PRIVATE,
  );
  jobs.set(crawl.id, { crawl, subs, preset: preset?.name });
  gc();
  // L'audit entre dans l'historique dès son démarrage : une page rechargée en
  // cours de crawl le retrouve et se rebranche dessus.
  await store.begin(crawl, preset?.name).catch((e) => console.error("store", crawl.id, e));

  const checked = safeChatUrl(preset?.chatUrl);
  if (typeof checked !== "string") console.error("chat", preset?.name, checked.error);
  const notify = typeof checked === "string" ? checked : "";
  if (notify) {
    // Sans await : un espace Chat lent ne doit pas retarder la réponse à la CI.
    void chat.send(
      notify,
      chat.startCard({ host: store.hostOf(crawl.start, crawl.id), preset: preset?.name ?? "", at: crawl.startedAt }),
    );
  }

  crawl
    .run()
    .catch((e) => console.error("crawl", crawl.id, e))
    .finally(() => void finish(crawl, preset?.name, notify));
  return crawl;
}

/**
 * Fin de crawl : l'audit figé sur disque et l'historique élagué d'abord, la
 * notification ensuite — un espace Chat injoignable ne doit pas retarder
 * l'élagage, et un disque en échec ne doit pas avaler le message.
 */
async function finish(crawl: Crawl, preset: string | undefined, notify: string): Promise<void> {
  try {
    await store.save(crawl, preset);
    await store.prune((id) => jobs.get(id)?.crawl.running === true);
  } catch (e) {
    console.error("store", crawl.id, e);
  }
  if (!notify) return;
  // Une seule passe sur les lignes : le total, et les premières à montrer.
  const top: chat.Broken[] = [];
  let broken = 0;
  for (const r of crawl.rows.values()) {
    if (!isBroken(r)) continue;
    broken++;
    if (top.length < chat.MAX_BROKEN_SHOWN) top.push({ url: r.url, status: r.status, error: r.error });
  }
  const s = crawl.stats();
  await chat.send(
    notify,
    chat.doneCard({
      host: store.hostOf(crawl.start, crawl.id),
      preset: preset ?? "",
      id: crawl.id,
      reason: crawl.reason,
      done: s.done,
      broken,
      elapsed: s.elapsed,
      top,
      base: PUBLIC_BASE,
    }),
  );
}

// ---- webhook ---------------------------------------------------------------

/** Dernier crawl lancé par preset : sert l'idempotence et l'intervalle minimum. */
const lastHook = new Map<string, { at: number; id: string }>();
/** Échecs d'authentification par IP. Contre l'énumération de noms, pas contre le
    brute-force : 256 bits de jeton n'en demandent pas. */
const authFails = new Map<string, { n: number; at: number }>();

function throttled(ip: string): boolean {
  const f = authFails.get(ip);
  return !!f && Date.now() - f.at <= FAIL_WINDOW && f.n >= FAIL_MAX;
}

function noteFail(ip: string) {
  const now = Date.now();
  const f = authFails.get(ip);
  if (!f || now - f.at > FAIL_WINDOW) authFails.set(ip, { n: 1, at: now });
  else f.n++;
  // La table ne doit pas grossir avec le nombre d'IP croisées.
  if (authFails.size > 1000) for (const [k, v] of authFails) if (now - v.at > FAIL_WINDOW) authFails.delete(k);
}

/** Réponse JSON non mise en cache : ni les jetons ni l'état d'un crawl ne doivent
    être stockés par un proxy ou par le navigateur. */
const NO_STORE = { "cache-control": "no-store" };
const noStore = (o: unknown, init: ResponseInit = {}) => Response.json(o, { ...init, headers: NO_STORE });

// ---- sessions --------------------------------------------------------------

/**
 * Header for one audit, live crawl first, otherwise what is on disk. A stored
 * audit still marked running has no live job behind it: the process died mid-crawl.
 */
async function meta(id: string): Promise<store.Meta | null> {
  const j = jobs.get(id);
  if (j) return store.metaOf(j.crawl, j.preset);
  const m = await store.read(id);
  if (!m) return null;
  const sitemap = m.sitemap ?? { sources: [], errors: [] }; // audits d'avant le sitemap
  if (!m.finishedAt) return { ...m, sitemap, finishedAt: m.startedAt, reason: "interrompu" };
  return { ...m, sitemap };
}

/** The rows of an audit: from memory while the job is live, from disk afterwards. */
async function rowsOf(id: string): Promise<Iterable<Row> | AsyncIterable<Row> | null> {
  const j = jobs.get(id);
  if (j) return j.crawl.rows.values();
  const m = await store.read(id);
  return m ? store.rows(id) : null;
}

// ---- server ----------------------------------------------------------------

const server = Bun.serve({
  port: PORT,
  idleTimeout: 0, // SSE connections stay open for the whole crawl
  development: false,

  routes: {
    "/": () => new Response(INDEX, { headers: { "content-type": "text/html; charset=utf-8" } }),
    "/favicon.ico": new Response(null, { status: 204 }),
    "/health": new Response("ok"),

    "/api/sessions": async () => {
      const stored = await store.list();
      const live = await Promise.all(stored.map((m) => meta(m.id)));
      return Response.json(live.filter(Boolean));
    },

    "/api/crawl": {
      POST: async (req) => {
        let body: { url?: unknown; opts?: unknown };
        try {
          body = await req.json();
        } catch {
          return bad("corps JSON invalide");
        }
        const c = check(body.url, body.opts);
        if (refused(c)) return bad(c.error, c.code);
        const crawl = await launch(c);
        return Response.json({ id: crawl.id, start: crawl.start, opts: crawl.opts });
      },
    },

    "/api/crawl/:id": {
      GET: async (req) => {
        const m = await meta(req.params.id);
        return m ? Response.json(m) : bad("audit inconnu", 404);
      },
      DELETE: async (req) => {
        const j = jobs.get(req.params.id);
        if (j?.crawl.running) return bad("audit en cours : arrêtez-le d'abord");
        jobs.delete(req.params.id);
        const ok = await store.remove(req.params.id);
        return ok ? Response.json({ ok: true }) : bad("audit inconnu", 404);
      },
    },

    /** Replay of a finished audit, one wire row per line (NDJSON, streamed). */
    "/api/crawl/:id/rows": async (req) => {
      const src = await rowsOf(req.params.id);
      if (!src) return bad("audit inconnu", 404);
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(c) {
          let buf = "";
          for await (const r of src) {
            buf += JSON.stringify(wire(r)) + "\n";
            if (buf.length > 64 * 1024) {
              c.enqueue(enc.encode(buf));
              buf = "";
            }
          }
          if (buf) c.enqueue(enc.encode(buf));
          c.close();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
      });
    },

    "/api/crawl/:id/events": (req) => {
      const j = job(req);
      if (!j) return bad("crawl inconnu", 404);
      const enc = new TextEncoder();
      let self: Sub;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          self = (chunk) => {
            try {
              c.enqueue(enc.encode(chunk));
            } catch {
              j.subs.delete(self);
            }
          };
          j.subs.add(self);
          self("retry: 2000\n\n");
          self(frame({ type: "snapshot", rows: j.crawl.snapshot(), stats: j.crawl.stats(), start: j.crawl.start }));
          if (!j.crawl.running) self(frame({ type: "done", stats: j.crawl.stats(), reason: j.crawl.reason }));
        },
        cancel() {
          j.subs.delete(self);
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        },
      });
    },

    "/api/crawl/:id/stop": {
      POST: (req) => {
        const j = job(req);
        if (!j) return bad("crawl inconnu", 404);
        j.crawl.stop("arrêté manuellement");
        return Response.json({ ok: true });
      },
    },

    // ---- presets -----------------------------------------------------------
    // Ces routes ne sont pas plus authentifiées que le reste de l'API : qui
    // atteint /api/crawl peut déjà lancer le crawl de son choix. Voir README,
    // section « Sécurité » : seul /api/hooks/run est fait pour être exposé.

    "/api/presets": {
      GET: async () => noStore(await presets.list()),
      POST: async (req) => {
        let body: { name?: unknown; url?: unknown; opts?: unknown; chatUrl?: unknown };
        try {
          body = await req.json();
        } catch {
          return bad("corps JSON invalide");
        }
        if (!presets.validName(body.name)) {
          return bad("nom invalide : lettres, chiffres, tiret et souligné, 32 caractères max");
        }
        const c = check(body.url, body.opts);
        if (refused(c)) return bad(c.error, c.code);
        const notify = safeChatUrl(body.chatUrl);
        if (typeof notify !== "string") return bad(notify.error, notify.code);
        // On enregistre l'URL et les options telles que le crawl les recevra,
        // pour qu'un preset lance exactement ce que l'interface montrait.
        const r = await presets.put(body.name, c.target.href, c.opts, notify);
        return "error" in r ? bad(r.error) : noStore(r);
      },
    },

    "/api/presets/:name": {
      DELETE: async (req) =>
        (await presets.remove(req.params.name)) ? Response.json({ ok: true }) : bad("preset inconnu", 404),
    },

    "/api/presets/:name/token": {
      POST: async (req) => {
        const token = await presets.rotate(req.params.name);
        return token ? noStore({ token }) : bad("preset inconnu", 404);
      },
    },

    // L'interface ne peut pas relire l'URL du webhook Google Chat, donc pas la
    // vider en la réenregistrant : elle se retire par ici.
    "/api/presets/:name/chat": {
      DELETE: async (req) =>
        (await presets.clearChat(req.params.name)) ? Response.json({ ok: true }) : bad("preset inconnu", 404),
    },

    // ---- webhook -----------------------------------------------------------

    "/api/hooks/run": {
      POST: async (req) => {
        // requestIP donne l'adresse de la connexion : derrière un proxy c'est
        // celle du proxy. X-Forwarded-For n'est pas lu, un en-tête se forge.
        const ip = server.requestIP(req)?.address ?? "?";
        if (throttled(ip)) return noStore({ error: "trop de tentatives" }, { status: 429 });

        if (Number(req.headers.get("content-length") ?? 0) > MAX_HOOK_BODY) {
          return noStore({ error: "corps trop volumineux" }, { status: 413 });
        }
        let body: { preset?: unknown };
        try {
          const raw = await req.text(); // borne aussi les corps envoyés sans content-length
          if (raw.length > MAX_HOOK_BODY) return noStore({ error: "corps trop volumineux" }, { status: 413 });
          body = JSON.parse(raw);
        } catch {
          return noStore({ error: "corps JSON invalide" }, { status: 400 });
        }

        // Le jeton ne se lit que dans l'en-tête : une query string finit dans
        // les logs d'accès du proxy et dans l'historique du navigateur.
        const token = /^bearer\s+(\S+)$/i.exec((req.headers.get("authorization") ?? "").trim())?.[1] ?? "";
        const preset = await presets.verify(body?.preset, token);
        if (!preset) {
          noteFail(ip);
          // Même message pour un preset inconnu et pour un mauvais jeton : la
          // réponse ne dit pas quels presets existent.
          return noStore({ error: "jeton ou preset invalide" }, { status: 401 });
        }

        const c = check(preset.url, preset.opts);
        if (refused(c)) return noStore({ error: c.error }, { status: c.code });

        const now = Date.now();
        const last = lastHook.get(preset.name);
        if (last) {
          // Idempotence : une CI qui rejoue son appel ne lance pas un second crawl.
          if (jobs.get(last.id)?.crawl.running) {
            return noStore({ preset: preset.name, id: last.id, running: true, started: false });
          }
          const wait = HOOK_MIN_INTERVAL - (now - last.at);
          if (wait > 0) {
            return Response.json(
              { error: "preset déclenché trop récemment", retryAfter: Math.ceil(wait / 1000) },
              { status: 429, headers: { ...NO_STORE, "retry-after": String(Math.ceil(wait / 1000)) } },
            );
          }
        }

        const crawl = await launch(c, preset);
        lastHook.set(preset.name, { at: now, id: crawl.id });
        return noStore({ preset: preset.name, id: crawl.id, running: true, started: true });
      },
    },

    "/api/crawl/:id/pages.csv": async (req) => {
      const src = await rowsOf(req.params.id);
      if (!src) return bad("audit inconnu", 404);
      return csvResponse(`pages-${await host(req.params.id)}.csv`, PAGES_HEADER, () => pagesRows(src));
    },

    "/api/crawl/:id/broken.csv": async (req) => {
      const src = await rowsOf(req.params.id);
      if (!src) return bad("audit inconnu", 404);
      return csvResponse(`liens-casses-${await host(req.params.id)}.csv`, BROKEN_HEADER, () => brokenRows(src));
    },
  },

  fetch: () => new Response("Not found", { status: 404 }),
});

async function host(id: string): Promise<string> {
  const j = jobs.get(id);
  if (j) return store.hostOf(j.crawl.start, id);
  return (await store.read(id))?.host ?? id;
}

console.log(`crowler → http://localhost:${server.port}  (réseaux privés ${BLOCK_PRIVATE ? "bloqués" : "autorisés"})`);
