import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, refreshSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { parseCookieHeader } from "@/lib/auth/access";

/**
 * Real per-user session gate — REPLACES the shared-password HTTP Basic Auth stopgap
 * this file used to be (see the README's "Real authentication and multi-tenancy"
 * section for the full history of that migration, and DEPLOYMENT.md for what changed
 * for anyone who already deployed the old version). `APP_ACCESS_PASSWORD(S)` and
 * `src/lib/auth/basicAuthCredentials.ts` are gone: a single shared password in front of
 * the whole app never distinguished one person from another, which is exactly what
 * multi-tenancy (separate entities, separate access grants) needs to do.
 *
 * WHAT THIS MIDDLEWARE DOES AND DOESN'T CHECK: it verifies that a request carries a
 * validly-signed, unexpired session cookie (`session.ts`'s `verifySessionToken`, which
 * needs only `crypto.subtle` — available on the Edge runtime this middleware runs on
 * by default, unlike `node:crypto` or a database connection). It does NOT check
 * whether that user has access to any particular entity — that's a per-entity
 * question (`EntityAccess`, via `authGuard.ts`'s `requireEntityAccess`) that needs a
 * database round trip, which this middleware deliberately doesn't do on every request
 * to every static-ish path. Every route/page that reads or writes entity-scoped data
 * calls `requireEntityAccess` itself — this middleware is the first, cheap gate
 * ("is anyone logged in at all"), not the only one.
 *
 * PUBLIC PATHS: `/login` (the page) and `/api/auth/login` (how you get a session in
 * the first place) are reachable with no session — everything else requires one.
 * `/api/auth/logout` is also public: clearing a cookie you don't have is harmless, and
 * gating logout behind having a valid session is pointless.
 *
 * NO OFF SWITCH: unlike the old Basic Auth stopgap (a no-op if unconfigured), this
 * middleware always enforces a session once `SESSION_SECRET` is set. If it's NOT set,
 * every request fails closed (see below) rather than silently allowing everything
 * through — a real login system with an unset secret is a misconfiguration to fix, not
 * a mode to fall back out of.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/: no
 * installed Next.js here to actually run this middleware against.
 *
 * SECURITY RESPONSE HEADERS (v0.20.0): every response this middleware returns —
 * success, redirect, or error — now carries a baseline set of hardening headers via
 * `withSecurityHeaders` below. This directly addresses two "Not started" rows from the
 * v0.20.0 task-status spreadsheet's Security Hardening area (security headers, and a
 * first-pass Content-Security-Policy) with a pure code change, no vendor/infra
 * decision needed. What's still NOT covered here, on purpose: Cloudflare/WAF/DDoS
 * protection (that's edge infrastructure in front of this app, not something this
 * middleware can do — see the README's Security Hardening section).
 *
 * CSRF AUDIT (v0.20.0), findings: every mutating route in this app (a) requires the
 * session cookie (`sameSite: "lax"`, `httpOnly`, `secure` in production — set in
 * /api/auth/login/route.ts), which browsers do NOT attach to a cross-site POST/PATCH/
 * DELETE at all (Lax only sends a cookie on a cross-site TOP-LEVEL navigation via GET);
 * (b) uses POST/PATCH/DELETE with a `Content-Type: application/json` body, never a
 * state-changing GET — confirmed by grep across every route under `src/app/api`; and
 * (c) this app sets no `Access-Control-Allow-Origin` header anywhere (confirmed by
 * grep), so a cross-origin `fetch()` can't get a CORS preflight to succeed for a
 * non-simple request like a JSON POST in the first place. Between (a) and (c), a
 * classic cross-site form submission can't carry the session cookie at all, and a
 * cross-origin script-driven request can't get past the browser's own preflight —
 * this is genuinely well-mitigated by the platform's own defaults as this app is built
 * today, not merely "probably fine." What this ISN'T: a dedicated CSRF token
 * (double-submit cookie or synchronizer token) as an explicit defense-in-depth layer,
 * which some compliance reviews (e.g. a SOC 2 audit) may still expect to see spelled
 * out regardless of how well the underlying browser-platform mitigations hold up —
 * that remains a real, separate future item if a specific review calls for it.
 *
 * SLIDING IDLE TIMEOUT (v0.20.0): every successfully-verified request now reissues
 * the session cookie via `refreshSessionToken` (session.ts), extending `expiresAt`
 * from "now" rather than leaving the original login-time expiry in place — see that
 * file's module doc comment for the full idle-timeout / absolute-cap design, and for
 * why the OTHER v0.20.0 session addition (`sessionVersion`, for "log out everywhere")
 * is deliberately NOT checked here.
 */

const PUBLIC_PATHS = ["/login", "/api/auth/login", "/api/auth/logout"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p);
}

/** Applies a baseline set of security response headers to any NextResponse this
 * middleware returns. Deliberately conservative on CSP — `default-src 'self'` plus
 * `'unsafe-inline'` for styles (this app's pages use plenty of inline `style={{...}}`
 * React props, which compile to inline styles) rather than a stricter nonce-based
 * policy, which would need real wiring through Next.js's own CSP nonce support to do
 * correctly. Tightening this further is called out as its own open item once any
 * third-party script (analytics, a chat widget) is actually added — see the README. */
function withSecurityHeaders(res: NextResponse): NextResponse {
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // Only meaningful over HTTPS (which is what "production" means for this app per
  // DEPLOYMENT.md's Vercel-issued TLS) — harmless to set unconditionally otherwise,
  // since a browser ignores Strict-Transport-Security on a plain HTTP response.
  res.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  res.headers.set(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'"
  );
  return res;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublicPath(pathname)) return withSecurityHeaders(NextResponse.next());

  const isApiRoute = pathname.startsWith("/api/");
  const secret = process.env.SESSION_SECRET;

  if (!secret) {
    // Fail closed, not open — see the doc comment above.
    return withSecurityHeaders(
      isApiRoute
        ? NextResponse.json({ error: "Server is not configured for login (SESSION_SECRET is unset)." }, { status: 500 })
        : new NextResponse("Server is not configured for login (SESSION_SECRET is unset).", { status: 500 })
    );
  }

  const token = parseCookieHeader(req.headers.get("cookie"), SESSION_COOKIE_NAME);
  const payload = token ? await verifySessionToken(token, secret) : null;

  if (payload) {
    // Sliding idle timeout (v0.20.0) — reissue the cookie with expiresAt extended
    // from "now," capped by the session's own absolute lifetime. See session.ts's
    // module doc comment for the full design, and why this does NOT check
    // `sessionVersion` here: that "log out everywhere" revocation check happens in
    // authGuard.ts's `resolveUserFromToken`, which already touches the database on
    // every request — middleware stays database-free by design (this file's own
    // top-of-file doc comment), so a just-revoked session still passes this gate but
    // is caught one layer in, same as the entity-access split this codebase already
    // applies elsewhere.
    const res = withSecurityHeaders(NextResponse.next());
    const refreshed = await refreshSessionToken(payload, secret);
    res.cookies.set(SESSION_COOKIE_NAME, refreshed, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
    });
    return res;
  }

  if (isApiRoute) {
    return withSecurityHeaders(NextResponse.json({ error: "Not logged in." }, { status: 401 }));
  }
  const loginUrl = new URL("/login", req.url);
  loginUrl.searchParams.set("next", pathname + req.nextUrl.search);
  return withSecurityHeaders(NextResponse.redirect(loginUrl));
}

// Everything except Next.js's own static asset paths — including API routes, which
// need this gate just as much as the pages do (a correction commit is a POST request,
// not a page view).
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
