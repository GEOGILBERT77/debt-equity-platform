"use client";

import { useState } from "react";
import { theme } from "@/lib/theme";

export interface WaterfallClassHolderRow {
  instrumentId: string;
  stakeholderId: string;
  stakeholderName: string;
  type: string;
  shares: string;
}

export interface WaterfallClassRow {
  id: string;
  seniorityRank: number;
  name: string;
  shares: string;
  liquidationPreferencePerShare: string;
  participating: boolean;
  participationCap: string | null;
  holders: WaterfallClassHolderRow[];
}

export interface WaterfallDebtRow {
  instrumentId: string;
  stakeholderId: string;
  stakeholderName: string;
  type: string;
  outstandingBalance: string | null;
}

const INSTRUMENT_TYPE_LABELS: Record<string, string> = {
  COMMON_STOCK: "Common stock",
  PREFERRED_STOCK: "Preferred stock",
  STOCK_OPTION: "Stock option",
  RSU: "RSU",
  RESTRICTED_STOCK: "Restricted stock",
  WARRANT: "Warrant",
  CONVERTIBLE_NOTE: "Convertible note (as-converted)",
  TERM_LOAN: "Term loan",
  REVOLVER: "Revolver",
  PIK_NOTE: "PIK note",
};

/**
 * v0.40.0 — "can we see what it would look like to have the class of stock with an
 * expand/collapse function to show the individual investors under each class? should
 * also include debt instruments in here" (George, verbatim). Split out of
 * cap-table-waterfall/page.tsx (which used to render this table inline, statically)
 * because expand/collapse needs client-side state that a server component can't hold.
 *
 * TWO SEPARATE THINGS SHOWN HERE, DELIBERATELY NOT MERGED INTO ONE STACK:
 *  - DEBT (term loans, revolvers, PIK notes) is real, must-be-repaid-first debt — it
 *    has no "seniority rank" the way preferred-vs-common does in an equity waterfall,
 *    and repaying it isn't governed by the same preference/participation math at all.
 *    Shown here purely for context (this is what comes off the top before any equity
 *    class below sees a dollar) — see capTableWaterfall.ts's module doc comment. It is
 *    NOT one of the rows in the class table below, and toggling it doesn't affect the
 *    waterfall math CapTableWaterfallCalculator.tsx runs (still correctly assumes the
 *    exit proceeds entered there are the value already left after this debt is repaid).
 *  - CLASSES (preferred series + the pooled common class) are the real waterfall
 *    stack, unchanged from before — just now with an expand/collapse arrow that reveals
 *    the individual stakeholders (name, instrument type, as-converted shares) pooled
 *    into that class, via `holdersByClassId` (capTableWaterfall.ts).
 */
export default function WaterfallClassesTable({ classes, debt }: { classes: WaterfallClassRow[]; debt: WaterfallDebtRow[] }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  function toggle(id: string) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  return (
    <>
      {debt.length > 0 && (
        <>
          <h3 style={{ marginBottom: "0.25rem" }}>Debt — repaid before any equity class below</h3>
          <p style={{ color: theme.inkMuted, fontSize: "0.85rem", marginTop: 0 }}>
            Not part of the waterfall class stack itself (see the note below the table) — shown here so the full
            priority picture is visible in one place: this comes off the top, then the equity classes below split
            whatever&apos;s left.
          </p>
          <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: "1.5rem" }}>
            <thead>
              <tr>
                <th style={cellStyle}>Lender / holder</th>
                <th style={cellStyle}>Instrument</th>
                <th style={cellStyle}>Outstanding balance</th>
              </tr>
            </thead>
            <tbody>
              {debt.map((d) => (
                <tr key={d.instrumentId}>
                  <td style={cellStyle}>{d.stakeholderName}</td>
                  <td style={cellStyle}>{INSTRUMENT_TYPE_LABELS[d.type] ?? d.type}</td>
                  <td style={cellStyle}>
                    {d.outstandingBalance !== null ? `$${Number(d.outstandingBalance).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"}
                  </td>
                </tr>
              ))}
              <tr>
                <td style={{ ...cellStyle, fontWeight: "bold" }} colSpan={2}>
                  Total debt
                </td>
                <td style={{ ...cellStyle, fontWeight: "bold" }}>
                  $
                  {debt
                    .reduce((sum, d) => sum + (d.outstandingBalance !== null ? Number(d.outstandingBalance) : 0), 0)
                    .toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </td>
              </tr>
            </tbody>
          </table>
        </>
      )}

      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th style={cellStyle}></th>
            <th style={cellStyle}>Seniority</th>
            <th style={cellStyle}>Class</th>
            <th style={cellStyle}>As-converted shares</th>
            <th style={cellStyle}>Preference / share</th>
            <th style={cellStyle}>Participating?</th>
            <th style={cellStyle}>Participation cap / share</th>
          </tr>
        </thead>
        <tbody>
          {classes.map((c) => (
            <ClassRows key={c.id} c={c} expanded={!!expanded[c.id]} onToggle={() => toggle(c.id)} />
          ))}
        </tbody>
      </table>
      {debt.length > 0 && (
        <p style={{ color: theme.inkMuted, fontSize: "0.8rem" }}>
          Debt above is excluded from the class stack on purpose, not a gap — a real liquidation pays creditors
          before any equity waterfall begins. The exit proceeds you enter below are assumed to already be the
          equity value left after the debt above is repaid.
        </p>
      )}
    </>
  );
}

function ClassRows({ c, expanded, onToggle }: { c: WaterfallClassRow; expanded: boolean; onToggle: () => void }) {
  return (
    <>
      <tr>
        <td style={cellStyle}>
          {c.holders.length > 0 && (
            <button
              type="button"
              onClick={onToggle}
              aria-label={expanded ? `Collapse ${c.name}` : `Expand ${c.name}`}
              style={toggleButtonStyle}
            >
              {expanded ? "▾" : "▸"}
            </button>
          )}
        </td>
        <td style={cellStyle}>{c.seniorityRank === Number.MAX_SAFE_INTEGER ? "Last (common)" : c.seniorityRank}</td>
        <td style={cellStyle}>{c.name}</td>
        <td style={cellStyle}>{Number(c.shares).toLocaleString()}</td>
        <td style={cellStyle}>${Number(c.liquidationPreferencePerShare).toFixed(2)}</td>
        <td style={cellStyle}>{c.participating ? "Yes" : "No"}</td>
        <td style={cellStyle}>{c.participationCap ? `$${Number(c.participationCap).toFixed(2)}` : "—"}</td>
      </tr>
      {expanded &&
        c.holders.map((h) => (
          <tr key={h.instrumentId} style={holderRowStyle}>
            <td style={cellStyle}></td>
            <td style={cellStyle}></td>
            <td style={{ ...cellStyle, paddingLeft: "1.5rem" }}>
              {h.stakeholderName} <span style={{ color: theme.inkMuted }}>— {INSTRUMENT_TYPE_LABELS[h.type] ?? h.type}</span>
            </td>
            <td style={cellStyle}>{Number(h.shares).toLocaleString()}</td>
            <td style={cellStyle} colSpan={3}></td>
          </tr>
        ))}
    </>
  );
}

const cellStyle: React.CSSProperties = { border: `1px solid ${theme.border}`, padding: "0.5rem", textAlign: "left" };
const holderRowStyle: React.CSSProperties = { background: theme.surfaceAlt, fontSize: "0.9rem" };
const toggleButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  fontSize: "0.9rem",
  padding: "0 0.25rem",
  color: theme.inkMuted,
};
