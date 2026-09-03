/**
 * Sitemap reader, zero dependency. Files are streamed through HTMLRewriter:
 * lol-html treats `<loc>` and `<lastmod>` as unknown elements and still reports
 * their text, so a 200 000-URL sitemap never materialises as a DOM or a string.
 *
 * Two shapes are understood, per sitemaps.org:
 *   <urlset>       a list of pages
 *   <sitemapindex> a list of sitemaps, followed one level deep
 */

export type SitemapUrl = { loc: string; lastmod?: string };

export type SitemapResult = {
  urls: SitemapUrl[];
  /** Files actually read, in the order they were fetched. */
  sources: string[];
  /** One entry per file that could not be read, already human-readable. */
  errors: string[];
  /** True when a cap cut the reading short: the list is partial. */
  truncated: boolean;
};

export type CollectOptions = {
  ua: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Gate applied to every sitemap URL before it is fetched (SSRF guard). */
  allow?: (u: URL) => boolean;
};

const MAX_BYTES = 20 * 1024 * 1024; // per file, after decompression
const MAX_URLS = 200_000;           // across the whole index
const MAX_CHILDREN = 50;            // sub-sitemaps followed from an index
const MAX_TEXT = 4096;              // a <loc> longer than this is not a URL
const FETCH_AT_ONCE = 5;            // sub-sitemaps are read a handful at a time
const CDATA = /^\[CDATA\[([\s\S]*)\]\]$/;

/**
 * Reads `seeds` and, for an index, the sitemaps they point to — one level only,
 * which is all the specification allows. Never throws: an unreachable or
 * malformed file lands in `errors` and the rest is still returned.
 */
export async function collect(seeds: string[], opts: CollectOptions): Promise<SitemapResult> {
  const out: SitemapResult = { urls: [], sources: [], errors: [], truncated: false };
  const seen = new Set<string>();
  let level = seeds.slice(0, MAX_CHILDREN);

  for (let depth = 0; depth < 2 && level.length; depth++) {
    const next: string[] = [];
    const targets: URL[] = [];
    for (const raw of level) {
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        out.errors.push(`${clip(raw)} : URL invalide`);
        continue;
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      if (opts.allow && !opts.allow(u)) {
        out.errors.push(`${clip(u.href)} : cible refusée`);
        continue;
      }
      if (seen.has(u.href)) continue;
      seen.add(u.href);
      targets.push(u);
    }

    for (let i = 0; i < targets.length && !opts.signal?.aborted; i += FETCH_AT_ONCE) {
      if (out.urls.length >= MAX_URLS) {
        out.truncated = true;
        break;
      }
      const batch = targets.slice(i, i + FETCH_AT_ONCE);
      const docs = await Promise.all(
        batch.map((u) => read(u.href, opts).then((d) => ({ u, d, e: null as unknown }), (e) => ({ u, d: null, e }))),
      );
      for (const { u, d, e } of docs) {
        if (!d) {
          out.errors.push(`${clip(u.href)} : ${errMsg(e)}`);
          continue;
        }
        out.sources.push(u.href);
        if (d.truncated) out.truncated = true;
        for (const entry of d.urls) {
          if (out.urls.length >= MAX_URLS) {
            out.truncated = true;
            break;
          }
          out.urls.push(entry);
        }
        if (depth > 0) {
          // An index nested deeper than one level is not read: say so rather
          // than return a list that quietly stops short.
          if (d.children.length) out.truncated = true;
          continue;
        }
        // Children are resolved against their index: a relative <loc> is
        // invalid per the spec but common enough to be worth accepting.
        for (const c of d.children) {
          if (next.length >= MAX_CHILDREN) {
            out.truncated = true;
            break;
          }
          next.push(safe(c, u.href));
        }
      }
    }
    level = next;
  }
  return out;
}

type Doc = { urls: SitemapUrl[]; children: string[]; truncated: boolean };

const MAX_HOPS = 5;

/**
 * Fetches and parses a single sitemap file. Throws on anything unreadable.
 * Redirects are followed by hand, not by fetch: each hop has to clear `allow`
 * again, otherwise a sitemap could bounce the reader onto a refused host.
 */
async function read(url: string, opts: CollectOptions): Promise<Doc> {
  const rc = new AbortController();
  const timer = setTimeout(() => rc.abort(new DOMException("timeout", "TimeoutError")), opts.timeoutMs ?? 15_000);
  const relay = () => rc.abort(new DOMException("aborted", "AbortError"));
  opts.signal?.addEventListener("abort", relay, { once: true });
  try {
    let at = url;
    for (let hop = 0; ; hop++) {
      const res = await fetch(at, {
        redirect: "manual",
        headers: { "user-agent": opts.ua, accept: "application/xml,text/xml,*/*;q=0.5" },
        signal: rc.signal,
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        await res.body?.cancel().catch(() => {});
        if (!loc) throw new Error("redirection sans en-tête Location");
        if (hop >= MAX_HOPS) throw new Error("trop de redirections");
        const next = new URL(loc, at);
        if (next.protocol !== "http:" && next.protocol !== "https:") throw new Error("redirection hors http");
        if (opts.allow && !opts.allow(next)) throw new Error("redirection vers une cible refusée");
        at = next.href;
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new Error("HTTP " + res.status);
      }
      if (!res.body) return { urls: [], children: [], truncated: false };
      // Relative <loc> resolve against where the file actually came from.
      return await parse(await body(res), at);
    }
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", relay);
  }
}

/**
 * A `.xml.gz` sitemap arrives as gzip *content*, not as a gzip transfer
 * encoding, so fetch leaves it compressed. The magic bytes decide rather than
 * the extension or the content-type, both of which servers get wrong.
 */
async function body(res: Response): Promise<ReadableStream<Uint8Array>> {
  const reader = res.body!.getReader();
  const first = await reader.read();
  const head = first.value;
  const gz = !!head && head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;
  const raw = new ReadableStream<Uint8Array>({
    start(c) {
      if (head?.length) c.enqueue(head);
      if (first.done) c.close();
    },
    async pull(c) {
      const { done, value } = await reader.read();
      if (done) c.close();
      else c.enqueue(value);
    },
    cancel: (r) => reader.cancel(r),
  });
  return gz ? raw.pipeThrough(new DecompressionStream("gzip")) : raw;
}

async function parse(stream: ReadableStream<Uint8Array>, base: string): Promise<Doc> {
  const doc: Doc = { urls: [], children: [], truncated: false };
  let cur: SitemapUrl | null = null;

  const commit = () => {
    if (cur?.loc) {
      if (doc.urls.length >= MAX_URLS) doc.truncated = true;
      else doc.urls.push({ ...cur, loc: safe(cur.loc, base) });
    }
    cur = null;
  };

  const rw = new HTMLRewriter()
    .on("url", {
      element(el) {
        commit();
        cur = { loc: "" };
        if (el.selfClosing) cur = null;
        else el.onEndTag(() => commit());
      },
    })
    .on("url loc", grab((v) => { if (cur) cur.loc = v; }))
    .on("url lastmod", grab((v) => { if (cur && v) cur.lastmod = v.slice(0, 40); }))
    .on("sitemap loc", grab((v) => {
      if (!v) return;
      if (doc.children.length >= MAX_CHILDREN) doc.truncated = true;
      else doc.children.push(v);
    }));

  const reader = rw.transform(new Response(stream)).body!.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) {
        doc.truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } finally {
    commit(); // a file cut short still yields the <url> it was in the middle of
  }
  return doc;
}

/**
 * Collects the text of one element. HTMLRewriter hands over the raw source, so
 * entities are decoded here; `<![CDATA[…]]>`, which the HTML tokenizer reports
 * as a bogus comment, is unwrapped and taken literally.
 */
function grab(done: (value: string) => void) {
  let buf = "";
  return {
    element(el: { selfClosing: boolean; onEndTag(cb: () => void): void }) {
      buf = "";
      if (el.selfClosing) return done("");
      el.onEndTag(() => {
        done(buf.trim());
        buf = "";
      });
    },
    text(t: { text: string }) {
      if (buf.length < MAX_TEXT) buf += decode(t.text);
    },
    comments(c: { text: string }) {
      const m = CDATA.exec(c.text);
      if (m && buf.length < MAX_TEXT) buf += m[1];
    },
  };
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** `&amp;` in a sitemap `<loc>` is the rule, not the exception. */
function decode(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, g: string) => {
    if (g[0] === "#") {
      const n = g[1] === "x" || g[1] === "X" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return m;
      try {
        return String.fromCodePoint(n);
      } catch {
        return m;
      }
    }
    return NAMED[g.toLowerCase()] ?? m;
  });
}

const clip = (s: string) => (s.length > 120 ? s.slice(0, 120) + "…" : s);

function safe(href: string, base: string): string {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

function errMsg(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === "TimeoutError") return "délai dépassé";
    if (e.name === "AbortError") return "interrompu";
    return (e.message || e.name).slice(0, 140);
  }
  return String(e).slice(0, 140);
}
