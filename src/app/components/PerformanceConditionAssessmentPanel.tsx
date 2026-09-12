"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { theme } from "@/lib/theme";

/**
 * v0.38.0 — "the system can ask the user to assess performance and market based
 * awards for inclusion in amortization... as part of the preview process prior to
 * posting." This is that assessment step, surfaced on the instrument page right next
 * to ApproveAmortizationScheduleButton (see instruments/[id]/page.tsx) whenever the
 * instrument's latest term version is linked to a shared PerformanceCondition.
 *
 * Recording an assessment here does NOT itself re-approve anything — it just appends
 * a new PerformanceConditionAssessment row (see that model's append-only doc comment
 * in prisma/schema.prisma). The full monthly table above already reflects it
 * immediately (a live preview, recomputed on every page load), but a STALE existing
 * approval still needs its own explicit re-approval via ApproveAmortizationScheduleButton
 * — same "approval is a deliberate, one-time human action" posture as any other terms
 * change. `router.refresh()` after a successful post makes the live preview above
 * (and this panel's own "most recent assessment" line) reflect the new call
 * immediately, so the next click on "Approve this schedule" captures it.
 *
 * Every grant linked to the SAME condition (not just this one instrument) picks up
 * this assessment the next time ITS schedule is computed or approved too — nothing
 * else needs to be touched.
 */
export function PerformanceConditionAssessmentPanel({
  entityId,
  conditionId,
  conditionCode,
  linkedGrantCount,
  latestAssessment,
}: {
  entityId: string;
  conditionId: string;
  conditionCode: string;
  linkedGrantCount: number;
  latestAssessment: { effectiveDate: string; probable: boolean } | null;
}) {
  const router = useRouter();
  const [effectiveDate, setEffectiveDate] = useState(new Date().toISOString().slice(0, 10));
  const [probable, setProbable] = useState(latestAssessment?.probable ?? true);
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function handleRecord() {
    setStatus("loading");
    setMessage(null);
    try {
      const res = await fetch(`/api/entities/${entityId}/performance-conditions/${conditionId}/assessments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ effectiveDate, probable, note: note || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setMessage(data.error ?? "Failed to record assessment");
        return;
      }
      setStatus("idle");
      setNote("");
      router.refresh();
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Failed to record assessment");
    }
  }

  return (
    <div style={{ border: `1px solid ${theme.border}`, borderRadius: 4, padding: "0.75rem 1rem", margin: "0.75rem 0", background: theme.surfaceAlt }}>
      <p style={{ margin: 0, fontWeight: 600 }}>
        Assess &quot;{conditionCode}&quot; for amortization
      </p>
      <p style={{ margin: "0.25rem 0", color: theme.inkMuted, fontSize: "0.85rem" }}>
        Shared with {linkedGrantCount} grant{linkedGrantCount === 1 ? "" : "s"} in total.{" "}
        {latestAssessment
          ? `Most recently assessed ${latestAssessment.probable ? "probable" : "not probable"} as of ${latestAssessment.effectiveDate}.`
          : "Never assessed — every linked grant defaults to not-probable (no expense) until a first assessment is recorded."}
      </p>
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "flex-end", flexWrap: "wrap", marginTop: "0.5rem" }}>
        <label style={{ display: "flex", flexDirection: "column", fontSize: "0.8rem" }}>
          As of
          <input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} style={inputStyle} />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.85rem" }}>
          <input type="checkbox" checked={probable} onChange={(e) => setProbable(e.target.checked)} />
          Probable of being met
        </label>
        <label style={{ display: "flex", flexDirection: "column", fontSize: "0.8rem", flex: "1 1 200px" }}>
          Note (optional)
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} style={inputStyle} placeholder="Basis for this assessment" />
        </label>
        <button onClick={handleRecord} disabled={status === "loading"} style={buttonStyle}>
          {status === "loading" ? "Recording…" : "Record assessment"}
        </button>
      </div>
      {message && <p style={{ color: theme.danger.fg, marginTop: "0.5rem" }}>{message}</p>}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "0.35rem 0.5rem",
  border: `1px solid ${theme.border}`,
  borderRadius: 4,
};

const buttonStyle: React.CSSProperties = {
  padding: "0.5rem 1rem",
  border: `1px solid ${theme.border}`,
  borderRadius: 4,
  background: theme.surface,
  cursor: "pointer",
};
