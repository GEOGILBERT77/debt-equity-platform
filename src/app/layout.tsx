import { Suspense } from "react";
import { cookies } from "next/headers";
import { getCurrentUserFromToken } from "@/lib/auth/authGuard";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { NavBar } from "@/app/components/NavBar";

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
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const token = cookies().get(SESSION_COOKIE_NAME)?.value;
  const currentUser = await getCurrentUserFromToken(token).catch(() => null);

  return (
    <html lang="en">
      <body style={{ margin: 0 }}>
        {currentUser && (
          <Suspense fallback={null}>
            <NavBar userEmail={currentUser.email} />
          </Suspense>
        )}
        {children}
      </body>
    </html>
  );
}
