/** Minimal zero-dependency robots.txt matcher. */

type Rule = { allow: boolean; re: RegExp; len: number };

/** A robots.txt may list many sitemaps; beyond this it is noise, not a map. */
const MAX_SITEMAPS = 50;

export class Robots {
  private rules: Rule[] = [];
  crawlDelay = 0;
  /** URLs declared by `Sitemap:` lines, in file order. */
  readonly sitemaps: string[] = [];

  static async fetch(origin: string, ua: string, signal?: AbortSignal): Promise<Robots> {
    const r = new Robots();
    try {
      const res = await fetch(new URL("/robots.txt", origin), {
        headers: { "user-agent": ua },
        signal: signal ?? AbortSignal.timeout(10_000),
      });
      if (res.ok) r.parse(await res.text(), ua);
      else await res.body?.cancel();
    } catch {
      /* unreachable or malformed robots.txt: allow everything */
    }
    return r;
  }

  /** Keeps only the groups targeting `*` or our own token. */
  parse(txt: string, ua: string) {
    const token = ua.toLowerCase().split("/")[0]!;
    let applies = false;
    let sawUa = false;

    for (const raw of txt.split("\n")) {
      const line = raw.replace(/#.*$/, "").trim();
      if (!line) continue;
      const i = line.indexOf(":");
      if (i < 0) continue;
      const field = line.slice(0, i).trim().toLowerCase();
      const value = line.slice(i + 1).trim();

      if (field === "user-agent") {
        const v = value.toLowerCase();
        // A new agent list after directives starts a fresh group.
        if (sawUa === false) applies = false;
        sawUa = true;
        if (v === "*" || v === token) applies = true;
        continue;
      }
      // `Sitemap:` belongs to no group and is usually declared before the very
      // first `User-agent:` line, so it is read before the group test below —
      // and without touching `sawUa`, which only tracks agent/directive runs.
      if (field === "sitemap") {
        if (value && this.sitemaps.length < MAX_SITEMAPS) this.sitemaps.push(value);
        continue;
      }
      sawUa = false;
      if (!applies) continue;

      if (field === "disallow" || field === "allow") {
        if (field === "disallow" && value === "") continue; // "Disallow:" alone means allow all
        this.rules.push({ allow: field === "allow", re: toRegExp(value), len: value.length });
      } else if (field === "crawl-delay") {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) this.crawlDelay = Math.min(n * 1000, 30_000);
      }
    }
    // Longest match wins; Allow beats Disallow at equal length (Google's rule).
    this.rules.sort((a, b) => b.len - a.len || Number(b.allow) - Number(a.allow));
  }

  allows(pathAndQuery: string): boolean {
    for (const r of this.rules) if (r.re.test(pathAndQuery)) return r.allow;
    return true;
  }
}

/** robots.txt patterns support `*` (any run) and `$` (end anchor); everything else is literal. */
function toRegExp(pattern: string): RegExp {
  let src = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") src += ".*";
    else if (c === "$" && i === pattern.length - 1) src += "$";
    else src += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(src);
}
