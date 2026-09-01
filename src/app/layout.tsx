import { cookies } from "next/headers";
import { getCurrentUserFromToken } from "@/lib/auth/authGuard";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { LogoutButton } from "@/app/components/LogoutButton";

export const metadata = {
  title: "Debt & Equity Platform",
};

/**
 * Renders the current user's email + a sign-out control in a thin top bar on every
 * page — this is the one place that needed to become auth-aware, since it wraps every
 * route including `/login` itself. `getCurrentUserFromToken` returns `null` on the
 * login page (no session yet, or the user is actively logging in) and the bar is
 * simply omitted rather than shown empty; `src/middleware.ts` is what actually
 * enforces that every OTHER page requires a session — this bar is a convenience
 * (know who you're logged in as, a visible way to sign out), not itself the auth
 * check.
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
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              alignItems: "center",
              gap: "0.75rem",
              padding: "0.5rem 1rem",
              borderBottom: "1px solid #eee",
              fontFamily: "sans-serif",
              fontSize: "0.85rem",
              color: "#555",
            }}
          >
            <span>{currentUser.email}</span>
            <LogoutButton />
          </div>
        )}
        {children}
      </body>
    </html>
  );
}
