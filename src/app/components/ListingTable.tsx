import { theme } from "@/lib/theme";

export interface ListingTableColumn {
  /** A plain string in almost every caller; React.ReactNode is there for the rare
   * header that needs a sub-label (e.g. a scenario's exit-proceeds value under its
   * name in a comparison matrix) — see CapTableWaterfallCalculator.tsx. */
  label: React.ReactNode;
  align?: "left" | "right";
}

/** A cell that spans multiple columns — build with spanCell(), never by hand. */
export interface ListingTableSpannedCell {
  __colSpan: number;
  content: React.ReactNode;
}

/**
 * Wraps `content` so it renders across `span` columns instead of one — for a totals
 * row like "Total unrecognized cost / weighted-average remaining period" that labels
 * several columns at once. Use in place of a plain cell anywhere in a row's `cells`
 * array; every other cell in that row still lines up with its own column normally
 * (see ListingTable's rendering, which tracks a running column index rather than the
 * array index specifically so a spanned cell doesn't throw off the alignment of the
 * cells after it).
 */
export function spanCell(content: React.ReactNode, span: number): ListingTableSpannedCell {
  return { __colSpan: span, content };
}

function isSpannedCell(cell: unknown): cell is ListingTableSpannedCell {
  return typeof cell === "object" && cell !== null && "__colSpan" in cell;
}

export interface ListingTableRow {
  key: string | number;
  cells: (React.ReactNode | ListingTableSpannedCell)[];
  /** Bolds the row and rules above it — a grand total, a grand summary line, etc. */
  highlight?: boolean;
}

/**
 * "Listing table" (v0.43.0) — the third, catch-all format for tables that are neither
 * a periodic schedule (ScheduleGridTable.tsx) nor an investor/instrument-class
 * ownership rollup (CapTableOwnershipTable.tsx): plain one-row-per-record listings —
 * journal entries, audit trail events, grants, filing obligations, documents, entities
 * — that have no natural "expand for detail" or "sequence of periods" shape, but still
 * deserve better than the original bare bordered `<table>` + per-file `cellStyle`
 * pattern this whole app used before the "CapStack Table Styles" pass (see
 * ScheduleGridTable.tsx and CapTableOwnershipTable.tsx's own doc comments for that
 * pass's origin). Same card shell and hairline-row chrome as those two, minus the
 * things that don't apply here: no sticky header/scroll container (these aren't long
 * enough to need it — a page with a genuinely long listing can still wrap this in its
 * own `maxHeight`/`overflowY` div at the call site), no zebra striping (a busy zebra
 * pattern reads worse on a plain event/record list than a quiet hover highlight — see
 * the ".de-listing-table" rule in globals.css).
 *
 * Deliberately dumb/presentational, same as its two siblings: callers pass
 * already-formatted cell content, not raw values. A cell wrapped with spanCell() is
 * the one exception to "plain content in" — see that helper's doc comment.
 */
export function ListingTable({
  columns,
  rows,
  emptyMessage = "Nothing to show yet.",
}: {
  columns: ListingTableColumn[];
  rows: ListingTableRow[];
  emptyMessage?: string;
}) {
  if (rows.length === 0) {
    return <p style={{ color: theme.inkMuted }}>{emptyMessage}</p>;
  }

  return (
    <div style={shellStyle}>
      <div style={{ overflowX: "auto" }}>
        <table className="de-listing-table" style={tableStyle}>
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
            {rows.map((row) => {
              // A running column index, not the cells array index: a spanned cell
              // occupies one array slot but several column slots, so every cell
              // after it still needs to line up with the RIGHT column definition
              // for alignment purposes. See spanCell()'s doc comment.
              let colIdx = 0;
              return (
                <tr key={row.key} style={row.highlight ? highlightRowStyle : undefined}>
                  {row.cells.map((cell, i) => {
                    const spanned = isSpannedCell(cell);
                    const span = spanned ? cell.__colSpan : 1;
                    const content = spanned ? cell.content : cell;
                    const rightAlign = !spanned && columns[colIdx]?.align === "right";
                    colIdx += span;
                    return (
                      <td
                        key={i}
                        colSpan={span > 1 ? span : undefined}
                        style={{
                          ...tdStyle,
                          textAlign: rightAlign ? "right" : "left",
                          fontFamily: rightAlign ? theme.font.mono : undefined,
                        }}
                      >
                        {content}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
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

const tableStyle: React.CSSProperties = { borderCollapse: "collapse", width: "100%", fontSize: "0.88rem" };

const thStyle: React.CSSProperties = {
  background: theme.surfaceAlt,
  color: theme.inkMuted,
  fontSize: "0.72rem",
  textTransform: "uppercase",
  letterSpacing: "0.03em",
  padding: "0.55rem 0.9rem",
  borderBottom: `1px solid ${theme.border}`,
  whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "0.6rem 0.9rem",
  borderBottom: `1px solid ${theme.border}`,
  fontVariantNumeric: "tabular-nums",
  verticalAlign: "top",
};

const highlightRowStyle: React.CSSProperties = {
  fontWeight: 700,
  borderTop: `1px solid ${theme.ink}`,
};
