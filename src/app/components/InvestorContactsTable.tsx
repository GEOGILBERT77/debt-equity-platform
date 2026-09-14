"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { theme, statusPillStyle } from "@/lib/theme";
import { ListingTable } from "@/app/components/ListingTable";
import { StakeholderDocumentsTrigger } from "@/app/components/StakeholderDocumentsTrigger";

export interface InvestorContactRow {
  id: string;
  name: string;
  contactPersonName: string;
  investorTypeLabel: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
  status: "INTEGRATED" | "INVITED" | "NOT_INVITED";
}

type InviteResult = { id: string; name: string; ok: boolean; inviteUrl?: string; expiresAt?: string; error?: string };

function StatusCell({ status }: { status: InvestorContactRow["status"] }) {
  if (status === "INTEGRATED") return <span style={statusPillStyle("success")}>Integrated</span>;
  if (status === "INVITED") return <span style={statusPillStyle("warning")}>Invited</span>;
  return <span style={{ color: theme.inkMuted, fontSize: "0.85rem" }}>Not invited</span>;
}

/**
 * Client half of the "Investor Contacts" page (v0.45.0) — the checkbox selection,
 * bulk "Invite to Portal," and "Send Message" actions all need client-side state, so
 * this is split out of page.tsx the same way NewStakeholderForm.tsx is split out of
 * its page: the server component resolves entityId/access and does the data fetch +
 * status computation (StakeholderAccess/PortalInvite -> INTEGRATED/INVITED/NOT_INVITED
 * — see that page's own doc comment), then hands plain, already-computed rows to this
 * component. Nothing here talks to Prisma directly.
 *
 * "INVITE TO PORTAL" (bulk): calls the EXACT SAME
 * `POST /api/entities/:id/stakeholders/:stakeholderId/portal-invite` route
 * InvitePortalAccessButton.tsx already uses for one stakeholder at a time — once per
 * selected investor, in parallel — rather than adding a new bulk-specific API route.
 * Each investor without an email on file is skipped with a per-row error (the route
 * would reject it anyway — see that route's doc comment) instead of failing the whole
 * batch. Skips nothing else: re-inviting an already-INTEGRATED or already-INVITED
 * investor just mints another valid link, the same "harmless, just slightly untidy"
 * behavior the route's own doc comment already accepts for the single-investor case.
 * `router.refresh()` after the batch finishes so the Status column picks up any
 * NOT_INVITED -> INVITED transitions without a manual reload.
 *
 * "SEND MESSAGE": DELIBERATELY does not send anything from inside this app — this
 * codebase has no outbound-email vendor wired up anywhere (see communications/
 * page.tsx's doc comment for the full reasoning: no vendor decision, no credential
 * store, no background job runner exist yet). Faking a "Send" button that silently
 * does nothing, or silently only pretends to queue something, would be strictly worse
 * than not having the feature. Instead, this opens a small compose panel and hands the
 * subject/body/recipients to the ADMIN'S OWN email client via a `mailto:` link — a
 * real, working mechanism today, and the same "admin sends it however they choose"
 * posture the portal-invite link already uses (see InvitePortalAccessButton.tsx's doc
 * comment). Recipients go in `bcc` (never `to`) so investors don't see each other's
 * email addresses; anyone selected with no email on file is named and skipped rather
 * than silently dropped.
 */
export function InvestorContactsTable({ entityId, investors }: { entityId: string; investors: InvestorContactRow[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [activePanel, setActivePanel] = useState<"none" | "message" | "invite">("none");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [inviteStatus, setInviteStatus] = useState<"idle" | "loading" | "done">("idle");
  const [inviteResults, setInviteResults] = useState<InviteResult[]>([]);

  const selectedIds = Object.keys(selected).filter((id) => selected[id]);
  const selectedInvestors = investors.filter((inv) => selected[inv.id]);
  const allSelected = investors.length > 0 && selectedIds.length === investors.length;

  function toggleOne(id: string) {
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function toggleAll() {
    setSelected(allSelected ? {} : Object.fromEntries(investors.map((inv) => [inv.id, true])));
  }

  function openPanel(panel: "message" | "invite") {
    setActivePanel((prev) => (prev === panel ? "none" : panel));
    setInviteStatus("idle");
    setInviteResults([]);
  }

  const recipientEmails = selectedInvestors.filter((inv) => inv.email).map((inv) => inv.email as string);
  const skippedForNoEmail = selectedInvestors.length - recipientEmails.length;

  function handleSendViaEmailClient() {
    const mailto = `mailto:?bcc=${encodeURIComponent(recipientEmails.join(","))}&subject=${encodeURIComponent(
      subject
    )}&body=${encodeURIComponent(body)}`;
    window.location.href = mailto;
  }

  async function handleBulkInvite() {
    setInviteStatus("loading");
    const results = await Promise.all(
      selectedInvestors.map(async (inv): Promise<InviteResult> => {
        if (!inv.email) return { id: inv.id, name: inv.name, ok: false, error: "No email on file" };
        try {
          const res = await fetch(`/api/entities/${entityId}/stakeholders/${inv.id}/portal-invite`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          });
          const data = await res.json();
          if (!res.ok) return { id: inv.id, name: inv.name, ok: false, error: data.error ?? "Failed to invite" };
          return { id: inv.id, name: inv.name, ok: true, inviteUrl: data.inviteUrl, expiresAt: data.expiresAt };
        } catch (err) {
          return { id: inv.id, name: inv.name, ok: false, error: err instanceof Error ? err.message : "Failed to invite" };
        }
      })
    );
    setInviteResults(results);
    setInviteStatus("done");
    router.refresh();
  }

  return (
    <div>
      <div style={actionBarStyle}>
        <span style={{ fontSize: "0.85rem", color: theme.inkMuted }}>
          {selectedIds.length === 0 ? "Select investors below to message them or invite them to the portal." : `${selectedIds.length} selected`}
        </span>
        <button type="button" onClick={() => openPanel("message")} disabled={selectedIds.length === 0} style={actionButtonStyle}>
          Send Message
        </button>
        <button type="button" onClick={() => openPanel("invite")} disabled={selectedIds.length === 0} style={actionButtonStyle}>
          Invite to Portal
        </button>
      </div>

      {activePanel === "message" && (
        <div style={panelStyle}>
          <h3 style={{ marginTop: 0, marginBottom: "0.5rem" }}>Send Message</h3>
          <p style={{ color: theme.inkMuted, fontSize: "0.85rem", marginTop: 0 }}>
            Opens a new email in your own email application, addressed (bcc) to the selected investors — this app
            has no email service connected, so it can't send messages itself. See "Communications" in the nav for
            the same limitation.
          </p>
          {skippedForNoEmail > 0 && (
            <p style={{ color: theme.warning.fg, fontSize: "0.85rem" }}>
              {skippedForNoEmail} of {selectedInvestors.length} selected investor(s) have no email on file and will
              be skipped.
            </p>
          )}
          {recipientEmails.length === 0 ? (
            <p style={{ color: theme.danger.fg, fontSize: "0.85rem" }}>None of the selected investors have an email on file.</p>
          ) : (
            <>
              <label style={labelStyle}>
                Subject
                <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} style={inputStyle} />
              </label>
              <label style={labelStyle}>
                Message
                <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} style={{ ...inputStyle, resize: "vertical" }} />
              </label>
              <button type="button" onClick={handleSendViaEmailClient} style={actionButtonStyle}>
                Open in email client ({recipientEmails.length} recipient{recipientEmails.length === 1 ? "" : "s"})
              </button>
            </>
          )}
        </div>
      )}

      {activePanel === "invite" && (
        <div style={panelStyle}>
          <h3 style={{ marginTop: 0, marginBottom: "0.5rem" }}>Invite to Portal</h3>
          <p style={{ color: theme.inkMuted, fontSize: "0.85rem", marginTop: 0 }}>
            Generates a one-time portal sign-up link for each selected investor — this app has no email service
            connected, so you'll need to copy and send each link yourself (see each row below).
          </p>
          {inviteStatus === "idle" && (
            <button type="button" onClick={handleBulkInvite} style={actionButtonStyle}>
              Generate {selectedInvestors.length} invite link{selectedInvestors.length === 1 ? "" : "s"}
            </button>
          )}
          {inviteStatus === "loading" && <p style={{ fontSize: "0.85rem" }}>Generating…</p>}
          {inviteStatus === "done" && (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {inviteResults.map((r) => (
                <li key={r.id} style={inviteResultRowStyle}>
                  <strong style={{ marginRight: "0.5rem" }}>{r.name}</strong>
                  {r.ok ? (
                    <CopyableLink url={r.inviteUrl as string} />
                  ) : (
                    <span style={{ color: theme.danger.fg, fontSize: "0.85rem" }}>{r.error}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <ListingTable
        columns={[
          {
            label: (
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                aria-label={allSelected ? "Deselect all investors" : "Select all investors"}
              />
            ),
          },
          { label: "Point of contact" },
          { label: "Investor / entity name" },
          { label: "Investor type" },
          { label: "Mailing address" },
          { label: "Email" },
          { label: "Phone" },
          { label: "Portal status" },
          { label: "" },
        ]}
        rows={investors.map((inv) => ({
          key: inv.id,
          cells: [
            <input type="checkbox" checked={!!selected[inv.id]} onChange={() => toggleOne(inv.id)} aria-label={`Select ${inv.name}`} />,
            inv.contactPersonName,
            <Link href={`/stakeholders/${inv.id}`}>{inv.name}</Link>,
            inv.investorTypeLabel ?? <span style={{ color: theme.inkMuted }}>Not set</span>,
            inv.address || <span style={{ color: theme.inkMuted }}>—</span>,
            inv.email || <span style={{ color: theme.inkMuted }}>—</span>,
            inv.phone || <span style={{ color: theme.inkMuted }}>—</span>,
            <StatusCell status={inv.status} />,
            <StakeholderDocumentsTrigger entityId={entityId} stakeholderId={inv.id} stakeholderName={inv.name} />,
          ],
        }))}
      />
    </div>
  );
}

function CopyableLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Same fallback reasoning as InvitePortalAccessButton.tsx — clipboard access can
      // be denied by the browser; the link is still shown as plain, selectable text.
    }
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
      <input
        readOnly
        value={url}
        onFocus={(e) => e.target.select()}
        style={{
          fontFamily: theme.font.mono,
          fontSize: "0.75rem",
          padding: "0.3rem 0.45rem",
          border: `1px solid ${theme.border}`,
          borderRadius: 4,
          background: theme.surface,
          color: theme.ink,
          width: 320,
        }}
      />
      <button type="button" onClick={copy} style={{ ...actionButtonStyle, padding: "0.25rem 0.6rem", fontSize: "0.8rem" }}>
        {copied ? "Copied!" : "Copy"}
      </button>
    </span>
  );
}

const actionBarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  marginBottom: "0.75rem",
};

const actionButtonStyle: React.CSSProperties = {
  padding: "0.45rem 0.9rem",
  border: `1px solid ${theme.ink}`,
  borderRadius: 4,
  background: theme.surfaceAlt,
  cursor: "pointer",
  fontSize: "0.85rem",
};

const panelStyle: React.CSSProperties = {
  background: theme.surface,
  border: `1px solid ${theme.border}`,
  borderRadius: 8,
  padding: "1rem",
  marginBottom: "1rem",
};

const labelStyle: React.CSSProperties = { display: "block", margin: "0.6rem 0", fontSize: "0.85rem" };
const inputStyle: React.CSSProperties = { display: "block", width: "100%", padding: "0.4rem", marginTop: "0.25rem" };
const inviteResultRowStyle: React.CSSProperties = {
  padding: "0.4rem 0",
  borderBottom: `1px solid ${theme.border}`,
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
};
