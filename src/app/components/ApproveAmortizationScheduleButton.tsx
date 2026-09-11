"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { theme } from "@/lib/theme";

/**
 * "Approve schedule" action for the full monthly amortization table shown on an
 * instrument's page (see instruments/[id]/page.tsx) — posts to
 * POST /api/instruments/:id/amortization-schedule, which persists the currently
 * previewed table as a new AmortizationScheduleApproval (see that route and
 * amortizationSchedule.ts for what "approve" actually does and why it's separate
 * from closing).
 *
 * This is a REQUIRED gate, not a formality: per direct feedback ("there should be an
 * approve function prior to the grant going live and being included in reporting"),
 * nothing computed here reaches any report until this button (or its entity-wide
 * counterpart, ApproveAllAmortizationSchedulesButton.tsx) has been clicked once for
 * this grant. It's a ONE-TIME gate, though — approving doesn't need to happen again
 * unless the terms change (an amendment gets its own one-time approval, bundled into
 * committing that modification — see the "Modify" flow's doc comments).
 */
export function ApproveAmortizationScheduleButton({ instrumentId }: { instrumentId: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function handleApprove() {
    setStatus("loading");
    setMessage(null);
    try {
      const res = await fetch(`/api/instruments/${instrumentId}/amortization-schedule`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setMessage(data.error ?? "Failed to approve schedule");
        return;
      }
      setStatus("idle");
      router.refresh();
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Failed to approve schedule");
    }
  }

  return (
    <div style={{ margin: "0.5rem 0" }}>
      <button onClick={handleApprove} disabled={status === "loading"} style={buttonStyle}>
        {status === "loading" ? "Approving…" : "Approve this schedule"}
      </button>
      {message && <p style={{ color: theme.danger.fg, marginTop: "0.5rem" }}>{message}</p>}
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
