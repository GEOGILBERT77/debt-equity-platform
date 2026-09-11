import Link from "next/link";
import { db } from "@/lib/db";
import { requirePageEntityAccess } from "@/lib/auth/pageGuard";
import { BoardConsentForm } from "@/app/components/BoardConsentForm";
import { theme } from "@/lib/theme";

/**
 * Board approval / consent record-keeping (v0.36.0) — list + create page for an
 * entity's BoardConsent records. See BoardConsent's doc comment in
 * prisma/schema.prisma and the board-consents API route's own doc comment for the
 * scope decision this whole feature rests on: a governance/audit RECORD, never a
 * workflow GATE. Nothing on this page — or anywhere else in this app — blocks an
 * instrument from being issued or marked ACTIVE for lack of a linked consent; this is
 * purely "the board approved this, on this date, here's the paper trail."
 *
 * Follows this app's established list-page shape (see stakeholders/[id]/page.tsx,
 * captable/page.tsx): a create form up top (BoardConsentForm.tsx, a client
 * component), the existing records below, server-rendered. VIEWER can see this page;
 * BoardConsentForm's own POST requires EDITOR, enforced server-side by the API route
 * regardless of what this page renders.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export default async function BoardConsentsPage({ params }: { params: { id: string } }) {
  await requirePageEntityAccess(params.id, "VIEWER");

  const entity = await db.entity.findUnique({ where: { id: params.id } });
  if (!entity) {
    return <p>No entity found with id "{params.id}".</p>;
  }

  const [boardConsents, instruments] = await Promise.all([
    db.boardConsent.findMany({
      where: { entityId: params.id },
      include: {
        instruments: { include: { instrument: { include: { stakeholder: { select: { id: true, name: true } } } } } },
        createdByUser: { select: { email: true } },
      },
      orderBy: { decisionDate: "desc" },
    }),
    db.instrument.findMany({
      where: { entityId: params.id },
      include: { stakeholder: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const instrumentOptions = instruments.map((i) => ({
    id: i.id,
    label: `${i.stakeholder.name} — ${i.type} (${i.issueDate.toISOString().slice(0, 10)})`,
  }));

  return (
    <main style={{ fontFamily: theme.font.body, padding: "2rem", maxWidth: 900 }}>
      <p>
        <Link href="/">&larr; All entities</Link> {" · "}
        <Link href={`/captable?entityId=${params.id}`}>{entity.name} cap table</Link>
      </p>
      <h1 style={{ fontFamily: theme.font.heading }}>Board consents — {entity.name}</h1>
      <p style={{ color: theme.inkMuted }}>
        A record of what the board approved and when — not a gate on issuing anything. See a linked instrument's
        own page for that instrument's actual status.
      </p>

      <BoardConsentForm entityId={params.id} instruments={instrumentOptions} />

      <h2>Recorded consents</h2>
      {boardConsents.length === 0 && <p style={{ color: theme.inkMuted }}>No board consents recorded yet.</p>}
      {boardConsents.map((c) => (
        <div key={c.id} style={cardStyle}>
          <h3 style={{ marginBottom: "0.25rem" }}>{c.title}</h3>
          <p style={{ color: theme.inkMuted, margin: "0 0 0.5rem", fontSize: "0.85rem" }}>
            {c.consentType === "WRITTEN_CONSENT" ? "Written consent" : "Board meeting"} · Decided{" "}
            {c.decisionDate.toISOString().slice(0, 10)} · Recorded by {c.createdByUser.email}
          </p>
          <p style={{ whiteSpace: "pre-wrap", margin: "0 0 0.5rem" }}>{c.description}</p>
          {c.instruments.length > 0 && (
            <>
              <p style={{ fontWeight: 600, margin: "0.5rem 0 0.25rem", fontSize: "0.85rem" }}>Linked instruments</p>
              <ul style={{ margin: 0, paddingLeft: "1.2rem" }}>
                {c.instruments.map((link) => (
                  <li key={link.id} style={{ fontSize: "0.85rem" }}>
                    <Link href={`/instruments/${link.instrument.id}`}>
                      {link.instrument.stakeholder.name} — {link.instrument.type}
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ))}
    </main>
  );
}

const cardStyle: React.CSSProperties = {
  border: `1px solid ${theme.border}`,
  borderRadius: 8,
  background: theme.surface,
  padding: "1rem",
  marginBottom: "1rem",
};
