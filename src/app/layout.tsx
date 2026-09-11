import { Suspense } from "react";
import { cookies } from "next/headers";
import { getCurrentUserFromToken } from "@/lib/auth/authGuard";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { NavBar } from "@/app/components/NavBar";
import "./globals.css";

export const metadata = {
  title: "Debt & Equity Platform",
};

/**
 * Renders the persistent top navigation bar (NavBar.tsx) on every page — this is the
 * one place that needed to become auth-aware, since it wraps every route including
 * `/login` itself. `getCurrentUserFromToken` returns `null` on the login page (no
 * session yet, or the user is actively logging in) and the bar is simply omitted
 * rather than shown empty; `src/middleware.ts` is what actually enforces that every
 * OTHER page requires a session — this bar is a convenience (navigation, knowing who
 * you're logged in as, a visible way to sign out), not itself the auth check.
 *
 * NavBar is wrapped in `<Suspense>` because it calls `useSearchParams()` (to carry
 * `?entityId=` across nav clicks — see that file's doc comment) — Next.js's App
 * Router requires that for any Client Component using it, so a page under this
 * layout doesn't unexpectedly bail out of static rendering or throw a build warning.
 * `fallback={null}` is deliberate: on the very first paint before hydration, showing
 * nothing is less jarring than a half-styled nav bar popping in a moment later.
 *
 * ENTITY SWITCHER (v0.36.0): NavBar also needs the full list of entities this user has
 * access to, to render as a dropdown (see NavBar.tsx's doc comment on why — added
 * directly in response to a user report that navigating between entities only through
 * the home page's entity list, with everything else requiring `?entityId=` already in
 * the URL, "doesn't work"). Fetched here rather than inside NavBar itself because
 * NavBar is a Client Component (it needs `useSearchParams()`/`useRouter()`) and this
 * layout is the nearest Server Component with access to `db` and the current user —
 * same reasoning as `defaultEntityId` already being fetched here instead of there.
 *
 * SOLE-ENTITY DEFAULT (v0.37.0): NavBar's own `?entityId=`-less fallback (see its
 * `withEntityId` note) used `currentUser.defaultEntityId` directly — the real database
 * column, unset until someone clicks "Set as default" — so a user who never did that
 * got sent to un-scoped destinations even with only one entity to possibly mean.
 * Reported directly: "most users will only have one entity, so the system should
 * default to it." Since this component already has the full `entities` list in hand,
 * it computes the same fallback `resolveDefaultEntityId` (pageGuard.ts) uses for every
 * page-level redirect — explicit default first, else the sole entity if there's
 * exactly one — inline here rather than an extra query, and passes THAT to NavBar
 * instead of the raw column.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const token = cookies().get(SESSION_COOKIE_NAME)?.value;
  const currentUser = await getCurrentUserFromToken(token).catch(() => null);

  const entities = currentUser
    ? await db.entity.findMany({
        where: { access: { some: { userId: currentUser.id } } },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      })
    : [];

  // See the SOLE-ENTITY DEFAULT doc comment above — mirrors resolveDefaultEntityId's
  // logic (pageGuard.ts) using the `entities` list already fetched above.
  const effectiveDefaultEntityId = currentUser?.defaultEntityId ?? (entities.length === 1 ? entities[0].id : null);

  return (
    <html lang="en">
      <head>
        {/* v0.34.0 — the "Slate" palette's two web fonts (see src/lib/theme.ts's
            `font` tokens): Public Sans for body/UI text, Fraunces for headings, IBM
            Plex Mono wherever digits line up in a column. Loaded once here rather
            than per-page since every page under this layout can use them. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Public+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        {currentUser && (
          <Suspense fallback={null}>
            <NavBar userEmail={currentUser.email} defaultEntityId={effectiveDefaultEntityId} entities={entities} />
          </Suspense>
        )}
        {children}
      </body>
    </html>
  );
}
