import { theme } from "@/lib/theme";

export interface ScheduleGridColumn {
  label: string;
  align?: "left" | "right";
}

export interface ScheduleGridRow {
  key: string | number;
  cells: React.ReactNode[];
  /** Bolds the row and rules above it — for a final/balloon payment, a grand total,
   * or any other row that should visually stand apart from the rows above it. */
  highlight?: boolean;
}

/**
 * "Dense schedule grid" table (v0.42.0) — George's pick (format #2 from the "CapStack
 * Table Styles" sample page) for every amortization schedule and any table with
 * monthly/periodic row indices: a sticky header so the column meaning never scrolls
 * out of view, alternating row shading so a long row stays easy to track edge to edge,
 * tabular-numeral right alignment for anything numeric, and a fixed-height scroll
 * container instead of letting a 60-row monthly table push the rest of the page down.
 * See the ".de-sched-grid" rule in globals.css for the zebra-stripe/hover rules this
 * needs that a plain inline `style={{}}` prop can't express — same reasoning as the
 * handful of other global rules already there (:focus-visible, ::placeholder).
 *
 * Deliberately dumb/presentational: callers pass already-formatted cell content
 * (strings or JSX), not raw numbers — this component only owns the table's shape and
 * chrome, not number formatting, so it doesn't need to know anything about
 * Decimal/DecimalValue or any particular instrument type's schedule shape. Used by the
 * instrument detail page (live/full-monthly/closed schedules), the stock option
 * amortization/forecast reports, the debt modification report, and grant modification/
 * correction previews — see each call site's own doc comment for what it passes.
 */
export function ScheduleGridTable({
  columns,
  rows,
  maxHeight = 360,
  emptyMessage = "Nothing to show yet.",
}: {
  columns: ScheduleGridColumn[];
  rows: ScheduleGridRow[];
  maxHeight?: number;
  emptyMessage?: string;
}) {
  if (rows.length === 0) {
    return <p style={{ color: theme.inkMuted }}>{emptyMessage}</p>;
  }

  return (
    <div style={shellStyle}>
      <div style={{ maxHeight, overflowY: "auto", overflowX: "auto" }}>
        <table className="de-sched-grid" style={tableStyle}>
          <thead>
            <tr>
              {columns.map((col, i) => (
                <th key={i} style={{ ...thStyle, textAlign: col.align === "right" ? "right" : "left" }}>
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} style={row.highlight ? highlightRowStyle : undefined}>
                {row.cells.map((cell, i) => {
                  const rightAlign = columns[i]?.align === "right";
                  return (
                    <td
                      key={i}
                      style={{
                        ...tdStyle,
                        textAlign: rightAlign ? "right" : "left",
                        fontFamily: rightAlign ? theme.font.mono : undefined,
                      }}
                    >
                      {cell}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const shellStyle: React.CSSProperties = {
  background: theme.surface,
  border: `1px solid ${theme.border}`,
  borderRadius: 10,
  overflow: "hidden",
};

const tableStyle: React.CSSProperties = {
  borderCollapse: "collapse",
  width: "100%",
  fontSize: "0.85rem",
};

const thStyle: React.CSSProperties = {
  position: "sticky",
  top: 0,
  background: theme.surfaceAlt,
  color: theme.inkMuted,
  fontSize: "0.72rem",
  textTransform: "uppercase",
  letterSpacing: "0.03em",
  padding: "0.55rem 0.9rem",
  borderBottom: `1px solid ${theme.border}`,
  zIndex: 1,
  whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "0.42rem 0.9rem",
  fontVariantNumeric: "tabular-nums",
};

const highlightRowStyle: React.CSSProperties = {
  fontWeight: 700,
  borderTop: `1px solid ${theme.ink}`,
};
