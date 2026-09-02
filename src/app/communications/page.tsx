import Link from "next/link";

/**
 * Placeholder for the "Communications" nav item (see NavBar.tsx) — the requested
 * feature is emailing investors and other stakeholders directly from within the app
 * (a grant confirmation, a capital call, a periodic update). Nothing in this codebase
 * sends email today — no outbound email vendor is wired up anywhere (see
 * INTEGRATIONS.md for the same "no credential storage, no background job runner"
 * gaps that block every vendor connection, not just this one).
 *
 * Deliberately NOT faked with a mock "compose email" form that doesn't actually send
 * anything — an honest "not built yet" page is less misleading than a form that looks
 * functional but silently does nothing. Building this for real needs: (1) a vendor
 * choice (SendGrid, Postmark, Resend, etc.), (2) a way to store that vendor's API key
 * per-entity or per-account (the same `EntityIntegration`-shaped credential store
 * INTEGRATIONS.md already calls out), and (3) a compose/send UI plus the backend
 * route that actually calls the vendor's API — none of which exists yet.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export default function CommunicationsPage({
  searchParams,
}: {
  searchParams: { entityId?: string };
}) {
  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 700 }}>
      <p>
        <Link href="/">&larr; All entities</Link>
      </p>
      <h1>Communications</h1>
      <p style={{ color: "#555" }}>
        Not built yet. This is meant to become a place to email investors and other stakeholders directly
        from the app — a grant confirmation, a capital call notice, a periodic update — rather than
        composing those by hand outside the system.
      </p>
      <p style={{ color: "#888", fontSize: "0.9rem" }}>
        Sending real email needs a vendor decision first (SendGrid, Postmark, Resend, etc.), plus a place to
        store that vendor's credentials and a real compose/send flow — see INTEGRATIONS.md for the
        architectural groundwork this and every other vendor connection needs.
      </p>
    </main>
  );
}
