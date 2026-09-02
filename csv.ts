/** Streaming CSV writer: no full-document concatenation, Excel-friendly. */

const BOM = "﻿";

/** Quotes every field, doubles inner quotes, and neutralises formula injection. */
export function cell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

export function row(fields: unknown[]): string {
  return fields.map(cell).join(",") + "\r\n";
}

/**
 * Builds a downloadable CSV Response from a row generator.
 * Rows are encoded and flushed in batches so a 100k-row export never
 * materialises in memory.
 */
export function csvResponse(
  filename: string,
  header: string[],
  rows: () => Iterable<unknown[]>,
): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(BOM + row(header)));
      let buf = "";
      for (const r of rows()) {
        buf += row(r);
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
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
