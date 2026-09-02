import {
  compileExcludes, Crawl, DEFAULTS, isPrivateHost, matchExclude, MAX_EXCLUDES,
  normalize, type Options,
} from "./crawler";
import { csvResponse } from "./csv";
import { BROKEN_HEADER, brokenRows, PAGES_HEADER, pagesRows } from "./report";

const PORT = Number(process.env.PORT ?? 3000);
const BLOCK_PRIVATE = process.env.BLOCK_PRIVATE_IPS !== "0";
const MAX_JOBS = 5;
const INDEX = Bun.file(new URL("./public/index.html", import.meta.url).pathname);

type Sub = (chunk: string) => void;
type Job = { crawl: Crawl; subs: Set<Sub> };

const jobs = new Map<string, Job>();

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

// ---- server ----------------------------------------------------------------

const server = Bun.serve({
  port: PORT,
  idleTimeout: 0, // SSE connections stay open for the whole crawl
  development: false,

  routes: {
    "/": () => new Response(INDEX, { headers: { "content-type": "text/html; charset=utf-8" } }),
    "/favicon.ico": new Response(null, { status: 204 }),
    "/health": new Response("ok"),

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
        crawl.run().catch((e) => console.error("crawl", crawl.id, e));
        return Response.json({ id: crawl.id, start: crawl.start, opts: crawl.opts });
      },
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

    "/api/crawl/:id/pages.csv": (req) => {
      const j = job(req);
      if (!j) return bad("crawl inconnu", 404);
      return csvResponse(`pages-${host(j)}.csv`, PAGES_HEADER, () => pagesRows(j.crawl.rows.values()));
    },

    "/api/crawl/:id/broken.csv": (req) => {
      const j = job(req);
      if (!j) return bad("crawl inconnu", 404);
      return csvResponse(`liens-casses-${host(j)}.csv`, BROKEN_HEADER, () => brokenRows(j.crawl.rows.values()));
    },
  },

  fetch: () => new Response("Not found", { status: 404 }),
});

function host(j: Job): string {
  try {
    return new URL(j.crawl.start).hostname;
  } catch {
    return j.crawl.id;
  }
}

console.log(`crowler → http://localhost:${server.port}  (réseaux privés ${BLOCK_PRIVATE ? "bloqués" : "autorisés"})`);
