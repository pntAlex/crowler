import {
  compileExcludes, Crawl, DEFAULTS, isPrivateHost, matchExclude, MAX_EXCLUDES,
  normalize, wire, type Options, type Row,
} from "./crawler";
import { csvResponse } from "./csv";
import { BROKEN_HEADER, brokenRows, PAGES_HEADER, pagesRows } from "./report";
import * as store from "./store";

const PORT = Number(process.env.PORT ?? 3000);
const BLOCK_PRIVATE = process.env.BLOCK_PRIVATE_IPS !== "0";
const MAX_JOBS = 5;
const INDEX = Bun.file(new URL("./public/index.html", import.meta.url).pathname);

type Sub = (chunk: string) => void;
type Job = { crawl: Crawl; subs: Set<Sub> };

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

function clampOpts(raw: unknown): Partial<Options> {
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

// ---- sessions --------------------------------------------------------------

/**
 * Header for one audit, live crawl first, otherwise what is on disk. A stored
 * audit still marked running has no live job behind it: the process died mid-crawl.
 */
async function meta(id: string): Promise<store.Meta | null> {
  const j = jobs.get(id);
  if (j) return store.metaOf(j.crawl);
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
        let body: { url?: string; opts?: unknown };
        try {
          body = await req.json();
        } catch {
          return bad("corps JSON invalide");
        }
        let target: URL;
        try {
          target = new URL(String(body.url ?? "").trim());
        } catch {
          return bad("URL invalide");
        }
        if (target.protocol !== "http:" && target.protocol !== "https:") return bad("seuls http et https sont acceptés");
        if (BLOCK_PRIVATE && isPrivateHost(target.hostname)) {
          return bad("cible sur réseau privé refusée (BLOCK_PRIVATE_IPS=0 pour l'autoriser)", 403);
        }

        const opts = clampOpts(body.opts);
        // The forced sitemap URL is fetched by the crawler like any other
        // target, so it passes the same two gates as the seed.
        if (opts.sitemapUrl) {
          let sm: URL;
          try {
            sm = new URL(opts.sitemapUrl);
          } catch {
            return bad("URL de sitemap invalide");
          }
          if (sm.protocol !== "http:" && sm.protocol !== "https:") return bad("sitemap : seuls http et https sont acceptés");
          if (BLOCK_PRIVATE && isPrivateHost(sm.hostname)) return bad("sitemap sur réseau privé refusé", 403);
        }
        const { res: excludes, errors } = compileExcludes(opts.exclude ?? []);
        if (errors.length) return bad("exclusion : " + errors.join(" ; "));
        // Starting inside an excluded zone is a contradictory request; say so
        // rather than crawling a single page and stopping.
        const seedKey = normalize(new URL(target.href), opts.ignoreQuery ?? false);
        const hit = matchExclude(seedKey, excludes);
        if (hit) return bad(`l'URL de départ est exclue par le motif /${hit.source}/`);

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
        jobs.set(crawl.id, { crawl, subs });
        gc();
        // The audit joins the history the moment it starts, so a page reloaded
        // mid-crawl finds it and reattaches.
        await store.begin(crawl).catch((e) => console.error("store", crawl.id, e));
        crawl
          .run()
          .catch((e) => console.error("crawl", crawl.id, e))
          .finally(() =>
            store
              .save(crawl)
              .then(() => store.prune((id) => jobs.get(id)?.crawl.running === true))
              .catch((e) => console.error("store", crawl.id, e)),
          );
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
