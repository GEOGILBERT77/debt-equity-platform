"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import { theme } from "@/lib/theme";

export interface CapTableGroupMember {
  key: string;
  label: string;
  href?: string;
  shares: string;
  percentOfGroup: string;
}

export interface CapTableGroupRow {
  key: string;
  label: string;
  href?: string;
  /** "By Instrument/Class" mode: number of distinct investors in this class.
   *  "By Investor" mode: number of distinct classes/instrument types this investor holds. */
  memberCount: number;
  shares: string;
  ownershipPercent: string;
  members: CapTableGroupMember[];
}

/**
 * "Interactive cap table" ownership table (v0.42.0) — George's pick from the "CapStack
 * Table Styles" sample page: format #1 (the clean ledger summary) for the top-level
 * rows, with format #3's expand/collapse pattern (already live on
 * WaterfallClassesTable.tsx) for the detail underneath each one. New in this version:
 * a "By Instrument/Class" / "By Investor" toggle that swaps which grouping the
 * top-level rows represent — same table chrome either way, just different rows and a
 * different thing revealed underneath (an investor's classes, or a class's investors).
 *
 * Deliberately dumb/presentational, same as ScheduleGridTable.tsx: both groupings are
 * pre-computed server-side in captable/page.tsx (see that file's doc comment for
 * exactly how a "class" is derived per instrument type, and for the aggregation math)
 * — this component only renders whichever of the two it's currently showing and owns
 * the expand/collapse interaction, nothing else.
 */
export function CapTableOwnershipTable({
  totalShares,
  byClass,
  byInvestor,
}: {
  totalShares: string;
  byClass: CapTableGroupRow[];
  byInvestor: CapTableGroupRow[];
}) {
  const [mode, setMode] = useState<"class" | "investor">("class");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const rows = mode === "class" ? byClass : byInvestor;
  const groupColumnLabel = mode === "class" ? "Class" : "Investor";
  const memberCountLabel = mode === "class" ? "Investors" : "Classes";
  const memberColumnHint = mode === "class" ? "investor" : "class / instrument type";

  function toggle(key: string) {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "0.65rem" }}>
        <label style={{ fontSize: "0.82rem", color: theme.inkMuted, display: "flex", alignItems: "center", gap: "0.5rem" }}>
          Group by
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as "class" | "investor")}
            style={selectStyle}
          >
            <option value="class">By Instrument/Class</option>
            <option value="investor">By Investor</option>
          </select>
        </label>
      </div>

      {rows.length === 0 ? (
        <p style={{ color: theme.inkMuted }}>No equity instruments yet.</p>
      ) : (
        <div style={shellStyle}>
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>{groupColumnLabel}</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>{memberCountLabel}</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Shares (FD)</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Ownership %</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const isOpen = !!expanded[row.key];
                  return (
                    <Fragment key={row.key}>
                      <tr style={groupRowStyle}>
                        <td style={tdStyle}>
                          <button type="button" onClick={() => toggle(row.key)} aria-expanded={isOpen} style={toggleStyle}>
                            <span style={{ ...arrowStyle, transform: isOpen ? "rotate(90deg)" : "none" }}>&#9656;</span>
                            {row.href ? <Link href={row.href}>{row.label}</Link> : <span>{row.label}</span>}
                          </button>
                        </td>
                        <td style={{ ...tdStyle, ...numStyle }}>{row.memberCount}</td>
                        <td style={{ ...tdStyle, ...numStyle }}>{row.shares}</td>
                        <td style={{ ...tdStyle, ...numStyle }}>{row.ownershipPercent}%</td>
                      </tr>
                      {isOpen &&
                        (row.members.length === 0 ? (
                          <tr style={memberRowStyle}>
                            <td style={{ ...tdStyle, paddingLeft: "2.4rem", color: theme.inkMuted, fontStyle: "italic" }} colSpan={4}>
                              No {memberColumnHint} detail available.
                            </td>
                          </tr>
                        ) : (
                          row.members.map((m) => (
                            <tr key={m.key} style={memberRowStyle}>
                              <td style={{ ...tdStyle, paddingLeft: "2.4rem" }}>
                                {m.href ? <Link href={m.href}>{m.label}</Link> : m.label}
                              </td>
                              <td style={tdStyle}></td>
                              <td style={{ ...tdStyle, ...numStyle, color: theme.inkMuted }}>{m.shares}</td>
                              <td style={{ ...tdStyle, ...numStyle, color: theme.inkMuted }}>{m.percentOfGroup}%</td>
                            </tr>
                          ))
                        ))}
                    </Fragment>
                  );
                })}
                <tr>
                  <td style={totalCellStyle}>Fully diluted total</td>
                  <td style={totalCellStyle}></td>
                  <td style={{ ...totalCellStyle, ...numStyle }}>{totalShares}</td>
                  <td style={{ ...totalCellStyle, ...numStyle }}>100.00%</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
      <p style={{ fontSize: "0.78rem", color: theme.inkMuted, marginTop: "0.4rem" }}>
        Click a row to see its {memberColumnHint} breakdown.
      </p>
    </div>
  );
}

const shellStyle: React.CSSProperties = {
  background: theme.surface,
  border: `1px solid ${theme.border}`,
  borderRadius: 10,
  overflow: "hidden",
};

const tableStyle: React.CSSProperties = { borderCollapse: "collapse", width: "100%" };

const thStyle: React.CSSProperties = {
  fontFamily: theme.font.heading,
  fontWeight: 600,
  fontSize: "0.82rem",
  color: theme.inkMuted,
  textAlign: "left",
  borderBottom: `2px solid ${theme.ink}`,
  padding: "0.5rem 0.9rem 0.55rem",
};

const tdStyle: React.CSSProperties = {
  padding: "0.75rem 0.9rem",
  borderBottom: `1px solid ${theme.border}`,
  textAlign: "left",
};

const numStyle: React.CSSProperties = {
  textAlign: "right",
  fontFamily: theme.font.mono,
  fontVariantNumeric: "tabular-nums",
};

const groupRowStyle: React.CSSProperties = { fontWeight: 600 };

const memberRowStyle: React.CSSProperties = { background: theme.surfaceAlt, fontSize: "0.87rem" };

const totalCellStyle: React.CSSProperties = {
  ...tdStyle,
  fontWeight: 700,
  borderTop: `2px solid ${theme.ink}`,
  borderBottom: "none",
};

const toggleStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.55rem",
  border: "none",
  background: "none",
  font: "inherit",
  fontWeight: 600,
  color: theme.ink,
  cursor: "pointer",
  padding: 0,
};

const arrowStyle: React.CSSProperties = {
  display: "inline-block",
  width: "0.7rem",
  color: theme.accent,
  transition: "transform 0.15s ease",
};

const selectStyle: React.CSSProperties = {
  padding: "0.3rem 0.5rem",
  border: `1px solid ${theme.border}`,
  borderRadius: 6,
  background: theme.surface,
  color: theme.ink,
  font: "inherit",
  fontSize: "0.82rem",
};
