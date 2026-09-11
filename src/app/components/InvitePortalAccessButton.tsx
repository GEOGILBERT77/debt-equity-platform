"use client";

import { useState } from "react";
import { theme } from "@/lib/theme";
import { smallButtonStyle } from "@/app/components/termsFields/FieldPrimitives";

/**
 * Admin-side control on stakeholders/[id]/page.tsx (v0.35.0): generates a one-time
 * portal invite link via POST /api/entities/:id/stakeholders/:stakeholderId/portal-invite
 * and displays it for the admin to copy — this app has no outbound-email vendor wired
 * up yet (see communications/page.tsx), so sending it is on the admin, not automatic.
 *
 * `hasEmail` disables the button with an explanatory note rather than letting the
 * request fail server-side — the API route would reject it anyway (an invite needs
 * somewhere to matched a StakeholderUser by), but catching it here is a better
 * experience than a round trip just to learn that.
 *
 * BOARD-OBSERVER CHECKBOX (v0.36.0): when checked, the generated invite carries
 * `grantsBoardObserverAccess: true` in its POST body — see the portal-invite route's
 * doc comment for what that does once accepted (the stakeholder sees the entity's full
 * cap table on the portal, in addition to their own holdings). Unchecked by default —
 * this is a deliberate, per-invite admin judgment call, not something that should be
 * easy to grant by accident.
 */
export function InvitePortalAccessButton({
  entityId,
  stakeholderId,
  hasEmail,
  alreadyHasAccess,
}: {
  entityId: string;
  stakeholderId: string;
  hasEmail: boolean;
  alreadyHasAccess: boolean;
}) {
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [boardObserver, setBoardObserver] = useState(false);
  const [grantedBoardObserver, setGrantedBoardObserver] = useState(false);

  async function generateInvite() {
    setStatus("loading");
    setError(null);
    setCopied(false);
    try {
      const res = await fetch(`/api/entities/${entityId}/stakeholders/${stakeholderId}/portal-invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grantsBoardObserverAccess: boardObserver }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Couldn't generate an invite link.");
      setInviteUrl(data.inviteUrl);
      setExpiresAt(data.expiresAt);
      setGrantedBoardObserver(!!data.grantsBoardObserverAccess);
      setStatus("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't generate an invite link.");
      setStatus("error");
    }
  }

  async function copyLink() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
    } catch {
      // Clipboard access can be denied by the browser — the link is still shown as
      // plain, selectable text below, so this isn't a dead end either way.
    }
  }

  if (!hasEmail) {
    return (
      <p style={{ color: theme.inkMuted, fontSize: "0.85rem" }}>
        Add an email address for this stakeholder before inviting them to the portal.
      </p>
    );
  }

  return (
    <div>
      <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.85rem", marginBottom: "0.5rem" }}>
        <input type="checkbox" checked={boardObserver} onChange={(e) => setBoardObserver(e.target.checked)} />
        Grant board-observer access (sees the entity's full cap table on the portal, not just their own holdings)
      </label>
      <button onClick={generateInvite} disabled={status === "loading"} style={smallButtonStyle}>
        {status === "loading" ? "Generating…" : alreadyHasAccess ? "Generate another invite link" : "Invite to portal"}
      </button>
      {alreadyHasAccess && status === "idle" && (
        <p style={{ color: theme.success.fg, fontSize: "0.8rem", margin: "0.35rem 0 0" }}>Already has portal access.</p>
      )}
      {error && <p style={{ color: theme.danger.fg, fontSize: "0.85rem", marginTop: "0.5rem" }}>{error}</p>}
      {status === "done" && inviteUrl && (
        <div style={{ marginTop: "0.6rem", padding: "0.75rem", background: theme.surfaceAlt, borderRadius: 6, border: `1px solid ${theme.border}` }}>
          <p style={{ margin: "0 0 0.4rem", fontSize: "0.85rem" }}>
            Send this link to the stakeholder however you'd like (email, text, in person) — it expires{" "}
            {expiresAt ? new Date(expiresAt).toLocaleDateString() : "in 7 days"} and works once.
            {grantedBoardObserver && " This invite grants board-observer access."}
          </p>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <input
              readOnly
              value={inviteUrl}
              onFocus={(e) => e.target.select()}
              style={{
                flex: 1,
                fontFamily: theme.font.mono,
                fontSize: "0.78rem",
                padding: "0.4rem 0.5rem",
                border: `1px solid ${theme.border}`,
                borderRadius: 4,
                background: theme.surface,
                color: theme.ink,
              }}
            />
            <button onClick={copyLink} style={smallButtonStyle}>
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
