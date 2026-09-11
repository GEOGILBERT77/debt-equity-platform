/**
 * v0.34.0 — the platform's shared color/type tokens ("Slate"), the palette George
 * picked from four mockup options (Ledger navy/brass, Sage green/plum, Slate
 * blue-grey/teal, Graphite dark mode — see the delivery README for this version for
 * the actual preview file). Before this, every page/component hardcoded its own
 * one-off hex values inline (grep the git history for `#666`/`#ddd`/`#92400e` etc. if
 * you need to see just how inconsistent it had gotten — dozens of slightly different
 * greys for "muted text" alone).
 *
 * This is a plain object, not CSS variables, because the whole app already styles
 * everything via inline `style={{...}}` React props (no CSS modules, no
 * styled-components, no Tailwind) — so `theme.ink` / `theme.border` etc. drop directly
 * into those same style objects with zero new tooling. `src/app/globals.css` mirrors
 * the same values as CSS custom properties on `:root`, for the handful of places (the
 * root layout's `<body>`, focus rings) that need a real stylesheet rule rather than an
 * inline style — keep the two in sync if you ever change a value here.
 *
 * SCOPE: this is a *chrome* palette — page backgrounds, text, borders, buttons, status
 * pills. It is deliberately NOT applied to `WaterfallSensitivityChart.tsx`'s
 * categorical series palette (the `PALETTE`/`OVERFLOW_COLOR` constants there) — that's
 * a separately validated colorblind-safe data-visualization palette, not a UI theme,
 * and swapping it for brand colors would silently break the colorblind-safety property
 * it was built for. Everything else in that file (axis lines, labels, hover guide) DOES
 * use these tokens like any other component.
 */

export const theme = {
  /** Page background — the "paper" every screen sits on. */
  bg: "#F3F5F8",
  /** Card / panel / table background — sits one step lighter than `bg`. */
  surface: "#FFFFFF",
  /** A subtler fill for table headers, panel headers, and hover rows. */
  surfaceAlt: "#E8ECF2",
  /** Hairline borders/dividers everywhere — table rules, card edges, input borders. */
  border: "#D9DFE8",
  /** Primary text color. */
  ink: "#1C2733",
  /** Secondary/caption/helper text — labels, timestamps, hint text. */
  inkMuted: "#5F6E7F",
  /** The nav bar, primary buttons, active/current-page indicators. */
  primary: "#33455F",
  /** Hover/active state for anything using `primary` as a background. */
  primaryHover: "#26374D",
  /** Links, focus rings, and small highlight touches — used sparingly, not as a second background color. */
  accent: "#1F8A7D",
  /** Text color for anything sitting on a `primary`- or `accent`-colored background. */
  onPrimary: "#FFFFFF",
  /** "Filed" / "approved" / success confirmations. */
  success: { bg: "#DCEEE9", fg: "#1F7A6C" },
  /** "Pending" / "due soon" / needs-attention-but-not-urgent states. */
  warning: { bg: "#F5E9D3", fg: "#8C6415" },
  /** "Overdue" / errors / destructive actions. */
  danger: { bg: "#F3DEE0", fg: "#A03A45" },
  /** Font stacks — Public Sans for body/UI text (also literally the U.S. federal
   *  government's own typeface for forms, which is a fitting coincidence for an app
   *  that produces IRS filings), Fraunces for headings (a serif with some real
   *  character, standing in for "this is a considered financial document" the way a
   *  ledger book's title page would), IBM Plex Mono wherever digits need to line up in
   *  a column (dollar amounts, share counts, dates in tables). */
  font: {
    body: "'Public Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    heading: "'Fraunces', Georgia, serif",
    mono: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  },
} as const;

/** Convenience for the common "status pill" look (used by every report table that
 * shows a PENDING/FILED/OVERDUE-style status) — `theme.pill("success")` returns a
 * ready-to-spread style object instead of every call site re-deriving bg/fg/radius. */
export function statusPillStyle(kind: "success" | "warning" | "danger"): import("react").CSSProperties {
  return {
    display: "inline-block",
    fontSize: "0.72rem",
    fontWeight: 600,
    padding: "0.15rem 0.55rem",
    borderRadius: 999,
    background: theme[kind].bg,
    color: theme[kind].fg,
    whiteSpace: "nowrap",
  };
}
