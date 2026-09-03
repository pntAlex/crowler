/** CSV shapes for the two exports. Shared by the server and the tests.
 *  Both accept a live crawl's rows or an audit streamed back from disk. */
import { isBroken, isOrphan, type Row } from "./crawler";

export const PAGES_HEADER = [
  "url", "status", "kind", "depth", "content_type", "response_ms",
  "bytes", "redirect_to", "error", "ref_count", "first_referer",
  "in_sitemap", "orphan", "sitemap_lastmod",
];

/** One row per URL. */
export async function* pagesRows(rows: Iterable<Row> | AsyncIterable<Row>) {
  for await (const r of rows) {
    yield [
      r.url, r.status || "", r.kind, r.depth, r.type, r.ms,
      r.bytes || "", r.redirect ?? "", r.error ?? "", r.refCount, r.refs[0]?.from ?? "",
      r.inSitemap ? 1 : 0, isOrphan(r) ? 1 : 0, r.lastmod ?? "",
    ];
  }
}

export const BROKEN_HEADER = [
  "target_url", "status", "error", "referer", "anchor_text",
  "target_kind", "total_referers", "referers_listed",
];

/**
 * One row per (broken URL, referer) pair — the actionable worklist.
 * `total_referers` vs `referers_listed` exposes the per-URL referer cap.
 */
export async function* brokenRows(rows: Iterable<Row> | AsyncIterable<Row>) {
  for await (const r of rows) {
    if (!isBroken(r)) continue;
    const tail = [r.kind, r.refCount, r.refs.length];
    if (!r.refs.length) {
      yield [r.url, r.status || "", r.error ?? "", "", "", ...tail];
      continue;
    }
    for (const ref of r.refs) {
      yield [r.url, r.status || "", r.error ?? "", ref.from, ref.text, ...tail];
    }
  }
}
