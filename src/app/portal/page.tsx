import Link from "next/link";
import { redirect } from "next/navigation";
import { requireCurrentPortalUser } from "@/lib/auth/portalPageGuard";
import { listAccessibleStakeholders } from "@/lib/auth/portalAuthGuard";
import { PortalLogoutButton } from "@/app/components/PortalLogoutButton";
import { theme } from "@/lib/theme";

/**
 * Stakeholder portal landing page (v0.35.0). Most people land here and immediately
 * bounce straight to their one stakeholder record (`/portal/[stakeholderId]`) — the
 * picker below only actually shows when the SAME StakeholderUser has accepted invites
 * from more than one company (see StakeholderUser's doc comment in
 * prisma/schema.prisma for why that's possible: one login, multiple entities).
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export default async function PortalHomePage() {
  const portalUser = await requireCurrentPortalUser();
  const stakeholders = await listAccessibleStakeholders(portalUser.id);

  if (stakeholders.length === 1) {
    redirect(`/portal/${stakeholders[0].id}`);
  }

  return (
    <main style={{ fontFamily: theme.font.body, padding: "2rem", maxWidth: 700, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <h1 style={{ fontFamily: theme.font.heading, margin: 0 }}>Your holdings</h1>
        <PortalLogoutButton />
      </div>

      {stakeholders.length === 0 && (
        <p style={{ color: theme.inkMuted }}>
          No holdings are linked to your account ({portalUser.email}) yet. If you were expecting to see something
          here, ask the company that invited you to check the email on file for your record.
        </p>
      )}

      {stakeholders.length > 1 && (
        <>
          <p style={{ color: theme.inkMuted }}>You have access to more than one company's records — pick one:</p>
          <ul style={{ listStyle: "none", padding: 0 }}>
            {stakeholders.map((s) => (
              <li key={s.id} style={{ marginBottom: "0.5rem" }}>
                <Link href={`/portal/${s.id}`} style={cardLinkStyle}>
                  <strong>{s.entity.name}</strong>
                  <span style={{ color: theme.inkMuted, marginLeft: "0.5rem" }}>{s.type.replace("_", " ").toLowerCase()}</span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}

const cardLinkStyle: React.CSSProperties = {
  display: "block",
  padding: "0.9rem 1.1rem",
  border: `1px solid ${theme.border}`,
  borderRadius: 8,
  background: theme.surface,
  color: theme.ink,
  textDecoration: "none",
};
