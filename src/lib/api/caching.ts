import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";

/**
 * HTTP caching headers for read-only report endpoints (v0.20.0) — closes the "HTTP
 * caching headers (ETag / Cache-Control) on read-only report endpoints" item in the
 * task-status spreadsheet's Performance & Scaling area. Deliberately the lightweight
 * option flagged there as "a good first step before the heavier Redis option" — this
 * doesn't cache anything server-side; it lets the CALLER (a browser, or a future
 * Cloudflare CDN sitting in front of this app) skip re-transferring a response body
 * that hasn't actually changed since its last request, via a standard conditional
 * GET (`If-None-Match` -> `304 Not Modified`).
 *
 * `private, max-age=0, must-revalidate` is the deliberate Cache-Control choice, not
 * a longer max-age: every report here is entity-scoped financial data behind
 * authentication, and a period can close or a correction can post between two
 * requests — `private` keeps a shared/CDN cache from serving one user's data to
 * another, and `must-revalidate` means a cache always asks this server "has this
 * actually changed" (an ETag check, cheap) rather than assuming a stale copy is fine
 * for some max-age window. The bandwidth savings this item is actually about come
 * entirely from the 304 path skipping the response BODY, not from skipping the
 * request itself.
 */

/** SHA-256 truncated to 27 hex characters (108 bits) — collision-irrelevant for a
 * cache-freshness check (this is not a security boundary), short enough to keep the
 * ETag header itself small. Wrapped in quotes per RFC 9110's ETag syntax. */
export function computeETag(body: string): string {
  return `"${createHash("sha256").update(body).digest("hex").slice(0, 27)}"`;
}

/** Builds either a 304 (if the request's `If-None-Match` matches this body's ETag) or
 * a normal 200 response carrying the body, ETag, and Cache-Control header. `body` is
 * whatever the response's raw text is — a JSON string, a CSV string — so this works
 * for both this app's JSON report routes and the CSV export route alike.
 *
 * Returns a standard web `Response` rather than `NextResponse` deliberately: a Next.js
 * App Router route handler can return either (`NextResponse` only adds cookie/rewrite
 * helpers this function doesn't need), and building on the platform-standard `Response`
 * keeps this module testable with plain Node — no dependency on the `next` package
 * actually being installed, which matters in this sandbox (see the README's "no npm
 * registry access" caveat) and costs nothing at runtime once it is. */
export function conditionalResponse(
  req: Pick<NextRequest, "headers">,
  body: string,
  opts: { contentType: string; maxAge?: number; extraHeaders?: Record<string, string> }
): Response {
  const etag = computeETag(body);
  const cacheControl = `private, max-age=${opts.maxAge ?? 0}, must-revalidate`;
  const headers = { ETag: etag, "Cache-Control": cacheControl, ...opts.extraHeaders };

  const ifNoneMatch = req.headers.get("if-none-match");
  if (ifNoneMatch === etag) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(body, { status: 200, headers: { "Content-Type": opts.contentType, ...headers } });
}

/** Convenience wrapper for the common case (a JSON-serializable payload) — most
 * routes want this, not `conditionalResponse` directly. */
export function conditionalJsonResponse(req: Pick<NextRequest, "headers">, payload: unknown, opts?: { maxAge?: number }): Response {
  return conditionalResponse(req, JSON.stringify(payload), { contentType: "application/json", maxAge: opts?.maxAge });
}
