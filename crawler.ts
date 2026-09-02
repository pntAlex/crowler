/**
 * Zero-dependency crawler. Links are extracted with Bun's native HTMLRewriter
 * (streaming, no DOM) so memory stays flat regardless of page size.
 */
import { Robots } from "./robots";

export const UA = "Crowler/1.0 (+link auditor)";
const REF_CAP = 20; // referers kept per URL; refCount stays exact beyond it
const MAX_BODY = 8 * 1024 * 1024;
const SKIP_SCHEME = /^(mailto|tel|sms|javascript|data|blob|file|ftp|about|whatsapp|geo):/i;

export type Kind = "page" | "asset" | "external";
export type Ref = { from: string; text: string };

export type Row = {
  url: string;
  kind: Kind;
  /** True for img/script/link/iframe/video targets, on-domain or not. */
  asset: boolean;
  depth: number;
  status: number; // 0 = never requested (network error, robots, bad URL)
  ms: number;
  bytes: number;
  type: string;
  redirect?: string;
  error?: string;
  refs: Ref[];
  refCount: number;
};

export type Options = {
  /** Regex patterns; a discovered URL matching any of them is never requested. */
  exclude: string[];
  checkExternal: boolean;
  checkAssets: boolean;
  respectRobots: boolean;
  includeSubdomains: boolean;
  followNofollow: boolean;
  ignoreQuery: boolean;
  concurrency: number;
  delayMs: number;
  maxDepth: number; // 0 = unlimited
  maxPages: number;
  timeoutMs: number;
};

export const DEFAULTS: Options = {
  exclude: [],
  checkExternal: true,
  checkAssets: true,
  respectRobots: true,
  includeSubdomains: false,
  followNofollow: false,
  ignoreQuery: false,
  concurrency: 8,
  delayMs: 0,
  maxDepth: 0,
  maxPages: 10_000,
  timeoutMs: 15_000,
};

export type Stats = {
  total: number;
  done: number;
  queued: number;
  inflight: number;
  ok: number;
  redirect: number;
  clientError: number;
  serverError: number;
  failed: number;
  capped: number;
  /** Count of excluded *link occurrences*, not of distinct URLs. */
  excluded: number;
  elapsed: number;
  live: boolean;
};

export type Event =
  | { type: "batch"; rows: unknown[]; stats: Stats }
  | { type: "done"; stats: Stats; reason: string };

export const MAX_EXCLUDES = 25;
const MAX_PATTERN = 300;
const MATCH_CAP = 2000; // URLs are matched truncated, to bound regex work
/* Two shapes that surface catastrophic backtracking: a run of one character,
   and a long realistic URL. The run is deliberately short — 26 characters cost
   ~200 ms on an exponential pattern (well over the budget below) while a longer
   run would hang this very check instead of reporting it. */
const PROBES = [
  "https://exemple.fr/" + "a".repeat(26),
  "https://exemple.fr/" + "ab-1/".repeat(40) + "?x=" + "1".repeat(40),
];

/**
 * Compiles user-supplied exclusion patterns, case-insensitive.
 * Rejects what cannot compile, and what is slow enough on a realistic URL to
 * stall the crawl (a pathological regex runs against every URL found).
 */
export function compileExcludes(patterns: string[]): { res: RegExp[]; errors: string[] } {
  const res: RegExp[] = [];
  const errors: string[] = [];
  for (const raw of patterns.slice(0, MAX_EXCLUDES)) {
    const src = raw.trim();
    if (!src) continue;
    if (src.length > MAX_PATTERN) {
      errors.push(`« ${src.slice(0, 40)}… » : motif trop long (max ${MAX_PATTERN} caractères)`);
      continue;
    }
    let re: RegExp;
    try {
      re = new RegExp(src, "i");
    } catch (e) {
      errors.push(`« ${src} » : ${e instanceof Error ? e.message : "motif invalide"}`);
      continue;
    }
    const t0 = performance.now();
    for (const probe of PROBES) re.test(probe);
    if (performance.now() - t0 > 40) {
      errors.push(`« ${src} » : motif trop lent, il ralentirait tout le crawl`);
      continue;
    }
    res.push(re);
  }
  return { res, errors };
}

export const matchExclude = (url: string, res: RegExp[]): RegExp | null =>
  res.find((re) => re.test(url.slice(0, MATCH_CAP))) ?? null;

/** Blocks link-local / loopback / RFC1918 targets (SSRF guard). */
export function isPrivateHost(raw: string): boolean {
  const host = raw.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host === "0.0.0.0") return true;
  // A bare hostname with no dot only resolves inside the local network.
  if (!host.includes(".") && !host.includes(":")) return true;

  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const a = +m[1]!, b = +m[2]!;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true;
  }
  if (/^(fc|fd|fe80)/.test(host)) return true;
  return false;
}

/** Canonical dedupe key: no hash, lowercase host, no default port, sorted query. */
export function normalize(u: URL, ignoreQuery: boolean): string {
  u.hash = "";
  if (ignoreQuery) u.search = "";
  else if (u.search) {
    const p = [...u.searchParams].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
    u.search = p.length ? "?" + p.map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&") : "";
  }
  if (!u.pathname) u.pathname = "/";
  return u.href;
}
const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, "+");

export class Crawl {
  readonly id = Math.random().toString(36).slice(2, 10);
  readonly rows = new Map<string, Row>();
  readonly opts: Options;
  readonly start: string;
  readonly startedAt = Date.now();
  finishedAt = 0;
  reason = "";

  private queue: Row[] = [];
  private head = 0;
  private active = 0;
  private doneCount = 0;
  private capped = 0;
  private dirty = new Set<string>();
  private hosts = new Set<string>();
  private robots: Robots | null = null;
  private ac = new AbortController();
  private timer: ReturnType<typeof setInterval> | null = null;
  private counts = { ok: 0, redirect: 0, clientError: 0, serverError: 0, failed: 0 };
  private excludes: RegExp[];
  private excluded = 0;
  private blockPrivate: boolean;

  constructor(
    startUrl: string,
    opts: Partial<Options>,
    private onEvent: (e: Event) => void,
    blockPrivate = true,
  ) {
    this.opts = { ...DEFAULTS, ...opts };
    this.excludes = compileExcludes(this.opts.exclude).res;
    const u = new URL(startUrl);
    this.blockPrivate = blockPrivate;
    this.hosts.add(u.hostname.toLowerCase());
    this.start = normalize(u, this.opts.ignoreQuery);
  }

  stop(reason = "stopped") {
    if (!this.finishedAt) this.reason = reason;
    this.ac.abort();
  }

  get running() {
    return this.finishedAt === 0;
  }

  async run() {
    const u = new URL(this.start);
    if (this.opts.respectRobots) {
      this.robots = await Robots.fetch(u.origin, UA, this.ac.signal);
      if (this.robots.crawlDelay > this.opts.delayMs) this.opts.delayMs = this.robots.crawlDelay;
    }
    this.add(u, this.start, "page", 0, null);
    this.timer = setInterval(() => this.flush(), 250);

    const n = Math.max(1, Math.min(64, this.opts.concurrency));
    try {
      await Promise.all(Array.from({ length: n }, () => this.worker()));
    } finally {
      if (this.timer) clearInterval(this.timer);
      this.finishedAt = Date.now();
      if (!this.reason) this.reason = this.capped ? "limite de pages atteinte" : "terminé";
      this.flush();
      this.onEvent({ type: "done", stats: this.stats(), reason: this.reason });
    }
  }

  // ---- queue -------------------------------------------------------------

  /** Single collection point for referers, so dedupe and referers cannot diverge. */
  private add(u: URL, key: string, kind: Kind, depth: number, ref: Ref | null, asset = false): Row | null {
    const seen = this.rows.get(key);
    if (seen) {
      if (ref && seen.refs.length < REF_CAP) seen.refs.push(ref);
      if (ref) {
        seen.refCount++;
        this.dirty.add(key);
      }
      return seen;
    }
    // The two switches are independent categories: an off-domain asset needs both.
    if (kind === "external" && !this.opts.checkExternal) return null;
    if (asset && !this.opts.checkAssets) return null;
    if (kind === "page" && this.opts.maxDepth > 0 && depth > this.opts.maxDepth) return null;
    if (this.rows.size >= this.opts.maxPages) {
      this.capped++;
      return null;
    }

    const row: Row = {
      url: key, kind, asset, depth, status: 0, ms: 0, bytes: 0, type: "",
      refs: ref ? [ref] : [], refCount: ref ? 1 : 0,
    };
    this.rows.set(key, row);
    this.dirty.add(key);

    if (this.blockPrivate && isPrivateHost(u.hostname)) {
      row.error = "private-host";
      this.counts.failed++;
      return row;
    }
    if (kind !== "external" && this.robots && !this.robots.allows(u.pathname + u.search)) {
      row.error = "robots";
      this.counts.failed++;
      return row;
    }
    this.queue.push(row);
    return row;
  }

  /** Resolves one discovered href and queues it. `depth` is the depth to assign. */
  private link(href: string, base: string, from: string, depth: number, asset: boolean, nofollow: boolean, text = "") {
    const raw = href.trim();
    if (!raw || raw.startsWith("#") || SKIP_SCHEME.test(raw)) return;
    if (nofollow && !this.opts.followNofollow) return;

    let u: URL;
    try {
      u = new URL(raw, base);
    } catch {
      // A malformed href is a broken link too: record it with its referer.
      const key = "invalid:" + raw.slice(0, 200);
      const seen = this.rows.get(key);
      if (seen) {
        seen.refCount++;
        if (seen.refs.length < REF_CAP) seen.refs.push({ from, text });
      } else if (this.rows.size >= this.opts.maxPages) {
        this.capped++;
        return;
      } else {
        this.rows.set(key, {
          url: key, kind: "page", asset, depth, status: 0, ms: 0, bytes: 0, type: "",
          error: "bad-url", refs: [{ from, text }], refCount: 1,
        });
        this.counts.failed++;
      }
      this.dirty.add(key);
      return;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return;

    const internal = this.isInternal(u.hostname);
    // Off-domain wins over the role: an external image is first of all an
    // external URL, so "check external links" governs it.
    const kind: Kind = internal ? (asset ? "asset" : "page") : "external";
    const key = normalize(u, this.opts.ignoreQuery);
    // Excluded URLs are dropped outright rather than recorded: the user asked
    // not to audit them, so listing them would only add noise.
    if (this.excludes.length && matchExclude(key, this.excludes)) {
      this.excluded++;
      return;
    }
    this.add(u, key, kind, depth, { from, text }, asset);
  }

  private isInternal(hostname: string): boolean {
    const h = hostname.toLowerCase();
    for (const base of this.hosts) {
      if (h === base) return true;
      if (this.opts.includeSubdomains && h.endsWith("." + base)) return true;
    }
    return false;
  }

  // ---- workers -----------------------------------------------------------

  private async worker() {
    while (!this.ac.signal.aborted) {
      if (this.head >= this.queue.length) {
        if (this.active === 0) return; // queue drained and nobody can refill it
        await Bun.sleep(5);
        continue;
      }
      const row = this.queue[this.head++]!;
      this.active++;
      try {
        await this.visit(row);
      } catch (e) {
        row.error = errMsg(e);
        this.counts.failed++;
      } finally {
        this.active--;
        this.doneCount++;
        this.dirty.add(row.url);
      }
      if (this.opts.delayMs) await this.wait(this.opts.delayMs);
    }
  }

  /** Politeness delay that gives up as soon as the crawl is stopped. */
  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const done = () => {
        clearTimeout(timer);
        this.ac.signal.removeEventListener("abort", done);
        resolve();
      };
      if (this.ac.signal.aborted) return done();
      timer = setTimeout(done, ms);
      this.ac.signal.addEventListener("abort", done, { once: true });
    });
  }

  private req(url: string, method: string, signal: AbortSignal) {
    return fetch(url, {
      method,
      redirect: "manual",
      headers: {
        "user-agent": UA,
        accept: method === "GET" ? "text/html,application/xhtml+xml,*/*;q=0.5" : "*/*",
        "accept-language": "*",
      },
      signal,
    });
  }

  private async visit(row: Row) {
    if (this.ac.signal.aborted) return;
    const t0 = performance.now();
    // One controller per URL, cleared on the way out: AbortSignal.timeout would
    // leave one live timer per request for the whole crawl.
    const rc = new AbortController();
    const timer = setTimeout(() => rc.abort(new DOMException("timeout", "TimeoutError")), this.opts.timeoutMs);
    const relay = () => rc.abort(new DOMException("aborted", "AbortError"));
    this.ac.signal.addEventListener("abort", relay, { once: true });
    try {
      await this.fetchRow(row, rc.signal);
    } finally {
      clearTimeout(timer);
      this.ac.signal.removeEventListener("abort", relay);
      row.ms = Math.round(performance.now() - t0);
    }
    this.tally(row);
  }

  private async fetchRow(row: Row, signal: AbortSignal) {
    const head = row.kind !== "page";
    let res = await this.req(row.url, head ? "HEAD" : "GET", signal);
    // Plenty of servers and CDNs reject HEAD; fall back to GET and drop the body.
    if (head && (res.status === 400 || res.status === 403 || res.status === 405 || res.status === 501)) {
      await res.body?.cancel().catch(() => {});
      res = await this.req(row.url, "GET", signal);
    }
    row.status = res.status;
    row.type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
    const len = Number(res.headers.get("content-length"));
    if (Number.isFinite(len) && len >= 0) row.bytes = len;

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!loc) row.error = "no-location";
      else {
        try {
          const target = new URL(loc, row.url);
          row.redirect = target.href;
          // The seed may redirect onto another host (example.com -> www.example.com);
          // adopt it so its pages stay internal.
          if (row.depth === 0 && !this.isInternal(target.hostname)) this.hosts.add(target.hostname.toLowerCase());
          // Same depth as the redirecting URL: a redirect chain must not eat the depth budget.
          this.link(loc, row.url, row.url, row.depth, row.asset, false);
        } catch {
          row.error = "bad-location";
        }
      }
    } else if (!head && isHtml(row.type)) {
      await this.parse(row, res);
    } else {
      await res.body?.cancel().catch(() => {});
    }
  }

  private tally(row: Row) {
    const s = row.status;
    if (row.error && s === 0) this.counts.failed++;
    else if (s >= 500) this.counts.serverError++;
    else if (s >= 400) this.counts.clientError++;
    else if (s >= 300) this.counts.redirect++;
    else if (s >= 200) this.counts.ok++;
    else this.counts.failed++;
  }

  /** Streams the body through HTMLRewriter, collecting hrefs without building a DOM. */
  private async parse(row: Row, res: Response) {
    let base: string | null = null;
    let cur: { href: string; text: string; nofollow: boolean } | null = null;
    // hrefs are resolved after the stream ends so a late <base href> still applies.
    const found: { href: string; text: string; nofollow: boolean; asset: boolean }[] = [];
    const flush = () => {
      if (cur) found.push({ ...cur, asset: false });
      cur = null;
    };

    const rw = new HTMLRewriter()
      .on("base[href]", {
        element(el) {
          base ??= el.getAttribute("href");
        },
      })
      .on("a[href]", {
        element(el) {
          flush();
          const href = el.getAttribute("href") ?? "";
          const rel = (el.getAttribute("rel") ?? "").toLowerCase();
          cur = { href, text: "", nofollow: rel.split(/\s+/).includes("nofollow") };
          if (el.selfClosing) flush();
          else el.onEndTag(() => flush());
        },
        text(t) {
          if (!cur || cur.text.length >= 120) return;
          cur.text += t.text;
          // Separate distinct text nodes, otherwise nested markup collapses into
          // "Bun.WebViewheadless browser automation".
          if (t.lastInTextNode) cur.text += " ";
        },
      });

    if (this.opts.checkAssets) {
      rw.on("img[src], script[src], iframe[src], source[src], video[src], audio[src], embed[src], track[src]", {
        element(el) {
          const v = el.getAttribute("src");
          if (v) found.push({ href: v, text: "", nofollow: false, asset: true });
        },
      }).on("link[href]", {
        element(el) {
          const rel = (el.getAttribute("rel") ?? "").toLowerCase();
          if (/(^|\s)(stylesheet|icon|manifest|preload|apple-touch-icon)(\s|$)/.test(rel)) {
            found.push({ href: el.getAttribute("href")!, text: "", nofollow: false, asset: true });
          }
        },
      });
    }

    const reader = rw.transform(res).body!.getReader();
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BODY) {
          row.error = "body-truncated";
          await reader.cancel().catch(() => {});
          break;
        }
      }
    } finally {
      flush();
      if (bytes) row.bytes = bytes;
    }

    const from = row.url;
    const b = base ? safeBase(base, from) : from;
    for (const l of found) {
      const text = l.text ? l.text.replace(/\s+/g, " ").trim().slice(0, 120) : "";
      this.link(l.href, b, from, row.depth + 1, l.asset, l.nofollow, text);
    }
  }

  // ---- reporting ---------------------------------------------------------

  /** Full state for a client connecting mid-crawl (or after it ended). */
  snapshot(): unknown[] {
    const out: unknown[] = [];
    for (const r of this.rows.values()) out.push(wire(r));
    return out;
  }

  stats(): Stats {
    return {
      total: this.rows.size,
      done: this.doneCount,
      queued: this.queue.length - this.head,
      inflight: this.active,
      ...this.counts,
      capped: this.capped,
      excluded: this.excluded,
      elapsed: (this.finishedAt || Date.now()) - this.startedAt,
      live: this.running,
    };
  }

  private flush() {
    if (!this.dirty.size) {
      this.onEvent({ type: "batch", rows: [], stats: this.stats() });
      return;
    }
    const rows: unknown[] = [];
    for (const key of this.dirty) {
      const r = this.rows.get(key);
      if (r) rows.push(wire(r));
    }
    this.dirty.clear();
    this.onEvent({ type: "batch", rows, stats: this.stats() });
  }
}

/** Broken = answered with an error status, or failed/was refused outright.
 *  A row still waiting in the queue (status 0, no error) is not broken yet, and
 *  a request the user cancelled was never checked rather than found faulty. */
export const isBroken = (r: Row) =>
  r.status >= 400 || (r.status === 0 && !!r.error && r.error !== "aborted");
const isHtml = (t: string) => t === "" || t === "text/html" || t === "application/xhtml+xml";

/** Referers are only shipped for broken URLs — that is the only place the UI shows them. */
export function wire(r: Row) {
  const o: Record<string, unknown> = {
    u: r.url, s: r.status, k: r.kind, d: r.depth, m: r.ms, b: r.bytes,
    t: r.type, n: r.refCount,
  };
  if (r.redirect) o.r = r.redirect;
  if (r.error) o.e = r.error;
  if (isBroken(r)) o.f = r.refs;
  return o;
}

function safeBase(href: string, fallback: string): string {
  try {
    return new URL(href, fallback).href;
  } catch {
    return fallback;
  }
}

function errMsg(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === "TimeoutError") return "timeout";
    if (e.name === "AbortError") return "aborted";
    return (e.message || e.name).slice(0, 140);
  }
  return String(e).slice(0, 140);
}
