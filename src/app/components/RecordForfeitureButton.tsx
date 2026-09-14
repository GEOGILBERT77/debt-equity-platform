"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { theme } from "@/lib/theme";
import { ListingTable } from "@/app/components/ListingTable";

export interface ForfeitureHistoryRow {
  id: string;
  forfeitureDate: string;
  quantityForfeited: string;
  eventType: "FORFEITED" | "EXPIRED";
  reason: string | null;
}

/**
 * Record + display forfeiture/expiration events against one STOCK_OPTION/RSU/
 * RESTRICTED_STOCK instrument — the write UI for InstrumentForfeitureEvent (v0.46.0),
 * mirrored on CorrectionPanel.tsx's "closed until you open it" pattern. This is what
 * turns the new award roll-forward report's "Forfeited"/"Expired" columns from
 * perpetually-zero into real recorded data.
 *
 * EXERCISES HAVE NO EQUIVALENT UI YET: this app already has a real, working
 * OptionExerciseEvent model and a POST /api/instruments/:id/option-exercises route
 * (used by the tax/compliance report and the portal's read-only "Exercise history"),
 * but — as of this version — nothing in the admin UI actually calls that POST route;
 * an exercise can currently only be recorded by calling the API directly. That's a
 * pre-existing gap, separate from this feature, not fixed here — flagged so a roll-
 * forward showing "Exercised: 0" isn't mistaken for a bug in the new report itself.
 */
export function RecordForfeitureButton({ instrumentId, history }: { instrumentId: string; history: ForfeitureHistoryRow[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [forfeitureDate, setForfeitureDate] = useState("");
  const [quantityForfeited, setQuantityForfeited] = useState("");
  const [eventType, setEventType] = useState<"FORFEITED" | "EXPIRED">("FORFEITED");
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function handleSubmit() {
    setStatus("loading");
    setMessage(null);
    try {
      const res = await fetch(`/api/instruments/${instrumentId}/forfeiture-events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ forfeitureDate, quantityForfeited, eventType, reason: reason || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setMessage(data.error ?? "Failed to record");
        return;
      }
      setStatus("idle");
      setForfeitureDate("");
      setQuantityForfeited("");
      setReason("");
      router.refresh();
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Failed to record");
    }
  }

  return (
    <div style={{ marginTop: "0.75rem" }}>
      {history.length > 0 && (
        <ListingTable
          columns={[{ label: "Date" }, { label: "Quantity", align: "right" }, { label: "Type" }, { label: "Reason" }]}
          rows={history.map((h) => ({
            key: h.id,
            cells: [h.forfeitureDate, h.quantityForfeited, h.eventType === "FORFEITED" ? "Forfeited" : "Expired", h.reason ?? "—"],
          }))}
        />
      )}
      {history.length === 0 && <p style={{ color: theme.inkMuted, fontSize: "0.9rem" }}>No forfeitures or expirations recorded.</p>}

      {!open ? (
        <button onClick={() => setOpen(true)} style={linkButtonStyle}>
          Record a forfeiture or expiration →
        </button>
      ) : (
        <div style={{ border: `1px solid ${theme.border}`, borderRadius: 4, padding: "1rem", marginTop: "0.5rem", maxWidth: 500 }}>
          <label style={labelStyle}>
            Date
            <input type="date" value={forfeitureDate} onChange={(e) => setForfeitureDate(e.target.value)} style={inputStyle} />
          </label>
          <label style={labelStyle}>
            Quantity
            <input
              type="text"
              inputMode="decimal"
              value={quantityForfeited}
              onChange={(e) => setQuantityForfeited(e.target.value)}
              style={inputStyle}
            />
          </label>
          <label style={labelStyle}>
            Type
            <select value={eventType} onChange={(e) => setEventType(e.target.value as "FORFEITED" | "EXPIRED")} style={inputStyle}>
              <option value="FORFEITED">Forfeited (left before vesting)</option>
              <option value="EXPIRED">Expired (vested, never exercised, contractual term ran out)</option>
            </select>
          </label>
          <label style={labelStyle}>
            Reason (optional)
            <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} style={inputStyle} />
          </label>
          <button onClick={handleSubmit} disabled={status === "loading"} style={buttonStyle}>
            {status === "loading" ? "Recording…" : "Record"}
          </button>
          <button onClick={() => setOpen(false)} style={{ ...buttonStyle, marginLeft: "0.5rem", background: "none" }}>
            Cancel
          </button>
          {message && <p style={{ color: theme.danger.fg, marginTop: "0.5rem" }}>{message}</p>}
        </div>
      )}
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  padding: "0.5rem 1rem",
  border: `1px solid ${theme.border}`,
  borderRadius: 4,
  background: theme.surfaceAlt,
  cursor: "pointer",
};
const linkButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: theme.accent,
  cursor: "pointer",
  padding: 0,
  font: "inherit",
};
const labelStyle: React.CSSProperties = { display: "block", margin: "0.75rem 0", fontSize: "0.9rem" };
const inputStyle: React.CSSProperties = { display: "block", width: "100%", padding: "0.4rem", marginTop: "0.25rem" };
