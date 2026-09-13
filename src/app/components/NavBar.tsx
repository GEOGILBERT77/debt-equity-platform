"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { LogoutButton } from "@/app/components/LogoutButton";
import { theme } from "@/lib/theme";

/**
 * The persistent top navigation bar, rendered once from `src/app/layout.tsx` (so
 * every page gets it automatically) whenever a user is logged in. Replaces the old
 * per-page approach of hand-writing a row of `<Link>`s at the top of every page.tsx
 * (home, /reports, /captable, etc.) — those links now live here instead, organized
 * the way an actual CPA using this day to day asked for: Home, a hierarchical "New
 * transactions" menu (grouped Equity/Debt, then by specific instrument type), the
 * cap table, GAAP reports, tax/compliance reports, communications, and help.
 *
 * ENTITY CONTEXT: this whole app is multi-entity (see prisma/schema.prisma's
 * Entity/EntityAccess model), and most of the destinations below only make sense for
 * a SPECIFIC entity. Rather than have every page pass its entityId down into this
 * component as a prop (which would mean touching every single page.tsx just to wire
 * the nav bar through), this component reads `?entityId=` directly off the CURRENT
 * url via `useSearchParams()` and carries it forward onto every link that needs it.
 * That means: once you're anywhere with an entityId in the URL (e.g. you clicked into
 * an entity's cap table from the home page), every nav item you click next stays
 * scoped to that same entity automatically. If there's no entityId yet (e.g. you're
 * still on the bare home page before picking one), these links go to their
 * un-scoped destination, and those destination pages already know how to handle that
 * (see instruments/new/page.tsx and reports/page.tsx's own "pass ?entityId=..."
 * messages) — this component doesn't duplicate that fallback UI itself.
 *
 * DEFAULT ENTITY (v0.21.0): when there's no `?entityId=` in the current URL at all,
 * this falls back to the user's `defaultEntityId` (see prisma/schema.prisma's doc
 * comment on that column) rather than going to the unscoped destination — so someone
 * who clicks "New transactions" straight from a page with no entity context lands on
 * their usual entity instead of hitting a "pass ?entityId=..." dead end. Still NOT a
 * full "currently active entity" switcher: there's no UI here to change entities
 * mid-session without going back through the home page or a cap table — this only
 * covers the "nothing in the URL yet" case. `withEntityId` below never overwrites an
 * entityId that's already explicitly in the URL, so once you're scoped to a specific
 * (possibly non-default) entity, every nav click correctly stays on THAT entity, not
 * silently jumping back to the default.
 *
 * Also absorbs what used to be a separate, second thin bar in layout.tsx (the
 * logged-in user's email + a sign-out button) into this same row's right side, via
 * the optional `userEmail` prop — one header instead of two stacked ones.
 *
 * ENTITY SWITCHER (v0.36.0): before this, the ONLY way to change which entity you were
 * looking at was to go back to the home page's entity list and click into a different
 * one's cap table — every other page just read whatever `?entityId=` was already in
 * the URL (or the default entity), with no in-page way to change it. Reported
 * directly: "having to navigate everything through the entity on the landing page
 * doesn't work" — a few entity-scoped pages were ALSO separately found to be missing
 * even the existing default-entity fallback (see audit-trail/page.tsx,
 * financial-statements/page.tsx, stakeholders/new/page.tsx), but that was a narrower
 * bug fix; this is the actual feature request. The fix: a `<select>` right in this bar
 * (`entities`, fetched once in layout.tsx alongside `defaultEntityId` — see that
 * file's doc comment), defaulting to whichever entity is currently active
 * (`entityId`, same resolution as everywhere else in this file). Picking a different
 * one navigates to THAT entity's cap table — deliberately always the cap table,
 * never "the same page you're on, for a different entity": several pages here are
 * either a single specific record (an instrument, a stakeholder) that belongs to
 * exactly one entity already, or carry page-specific query params (a report's date
 * range) that may not carry over sensibly, and guessing at a per-page rewrite for
 * every route risks landing on a broken or nonsensical URL. The cap table is this
 * app's established "entity home" (see captable/page.tsx and stakeholders/[id]/
 * page.tsx's own doc comments) — going there and then continuing to browse from its
 * links (which already all carry `?entityId=` forward via `withEntityId` below) is
 * one predictable click away from anywhere.
 *
 * DELIBERATELY DOES NOT change `defaultEntityId` — switching entities here is a
 * per-visit navigation action, not a change to what you land on next time you log in.
 * That stays a separate, deliberate choice via the "Set as default" button on the
 * home page (SetDefaultEntityButton.tsx).
 *
 * STOCK AWARD CONSOLIDATION (v0.37.0): the "New transactions" menu's Equity column used
 * to list "Stock option", "RSU", and "Restricted stock" as three separate entries, each
 * landing on the same general-purpose new-instrument form pre-set to one type. Replaced
 * with a single "Stock award" entry that opens StockAwardWizard.tsx — pick the award
 * type (NQ option, ISO option, RSU, or restricted stock) there, then manual entry or
 * bulk upload — since those three were, in practice, one decision tree split across
 * three redundant-feeling screens.
 *
 * NOTES / EQUITY FUNDING CONSOLIDATION (v0.41.0): George's ask, verbatim — "for debt,
 * there should be 3 categories: Term Loan, Notes (includes PIK and Convertible),
 * Revolver/LOC... common stock and preferred stock should be combined into 'New Equity
 * Funding'... 'Warrants' should be 'Standalone warrants,' while issuing debt with
 * warrants should be another option in the 'Notes' user choice." Concretely:
 *  - Debt: "PIK note" and "Convertible note" are no longer their own direct links —
 *    both (plus the new "debt + warrants" combination) are now reached through the
 *    bolded "Notes" entry, which opens NotesWizard.tsx. "Revolver" relabeled
 *    "Revolver/LOC" (same underlying REVOLVER type/href — no schema change). "Term
 *    loan" is unchanged, still a direct link.
 *  - Equity: "Common stock" and "Preferred stock" are no longer their own direct
 *    links — both are now reached through the bolded "New Equity Funding" entry,
 *    which opens EquityFundingWizard.tsx (choose issue-more-of-an-existing-class vs.
 *    create-a-new-class, then common or preferred). "Warrant" relabeled "Standalone
 *    warrants" (same underlying WARRANT type/href) to distinguish it from the
 *    debt+warrants combination now living inside "Notes". SAR keeps its own direct
 *    link — it didn't overlap with any of the above.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */

type InstrumentTypeLink = { label: string; type: string };

// v0.41.0 — "Standalone warrants" is the only direct link left in this column besides
// SAR: Common/Preferred moved into the bolded "New Equity Funding" entry (rendered
// separately, above this list — see the dropdown JSX below), which opens
// EquityFundingWizard.tsx. Renamed from "Warrant" to "Standalone warrants" specifically
// to distinguish it from "debt issued with warrants", which now lives inside the
// "Notes" wizard instead (see DEBT_INSTRUMENT_TYPES below and NotesWizard.tsx).
const EQUITY_INSTRUMENT_TYPES: InstrumentTypeLink[] = [
  { label: "Stock appreciation right (SAR)", type: "SAR" },
  { label: "Standalone warrants", type: "WARRANT" },
];

// v0.41.0 — "PIK note" and "Convertible note" moved into the bolded "Notes" entry
// (rendered separately, above this list — see the dropdown JSX below), which opens
// NotesWizard.tsx and also covers "debt issued with warrants" (no direct link of its
// own — there's no single InstrumentType for that combination; see NotesWizard.tsx's
// own doc comment for how it's modeled as two instruments). "Term loan" relabeled
// "Revolver" to "Revolver/LOC" per George's ask — same REVOLVER type/href either way.
const DEBT_INSTRUMENT_TYPES: InstrumentTypeLink[] = [
  { label: "Term loan", type: "TERM_LOAN" },
  { label: "Revolver/LOC", type: "REVOLVER" },
];

type ReportLink = { label: string; href: string; scoped?: boolean };

const GAAP_REPORT_GROUPS: { heading: string; items: ReportLink[] }[] = [
  {
    heading: "Entity reports",
    items: [
      { label: "Journal entries", href: "/reports", scoped: true },
      { label: "Financial statements", href: "/reports/financial-statements", scoped: true },
      { label: "Audit trail", href: "/reports/audit-trail", scoped: true },
      { label: "Modification audit", href: "/reports/modification-audit", scoped: true },
      { label: "Grants report", href: "/reports/grants", scoped: true },
      { label: "Cap table export (CSV)", href: "/api/reports/cap-table-export", scoped: true },
      { label: "Stock option tax/compliance", href: "/reports/option-tax-compliance", scoped: true },
      { label: "Debt modification / extinguishment", href: "/reports/debt-modification", scoped: true },
      { label: "Stock option amortization", href: "/reports/stock-option-amortization", scoped: true },
      { label: "Stock option forecast", href: "/reports/stock-option-forecast", scoped: true },
    ],
  },
  {
    // v0.21.0: "Debt modification / extinguishment" moved up into "Entity reports"
    // (below) since it's now a real database report, not a calculator — see
    // REPORTS-CONVERSION-PLAN.md for which of the rest of this group are next.
    heading: "ASC calculators (standalone — not yet converted to database reports)",
    items: [
      { label: "Option exercise / RSU settlement", href: "/reports/settlement" },
      { label: "Troubled debt restructuring", href: "/reports/troubled-debt-restructuring" },
      { label: "Beneficial conversion feature", href: "/reports/beneficial-conversion-feature" },
      { label: "Embedded derivative bifurcation", href: "/reports/embedded-derivative-bifurcation" },
      { label: "SAFE", href: "/reports/safe" },
      { label: "Two-class EPS", href: "/reports/eps" },
      { label: "ESPP", href: "/reports/espp" },
      { label: "Nonemployee awards", href: "/reports/nonemployee-awards" },
      { label: "Equity comp footnote disclosures", href: "/reports/equity-comp-disclosures" },
      { label: "Exit waterfall", href: "/reports/exit-waterfall" },
    ],
  },
];

function withEntityId(href: string, entityId: string | null): string {
  if (!entityId) return href;
  return `${href}${href.includes("?") ? "&" : "?"}entityId=${entityId}`;
}

export function NavBar({
  userEmail,
  defaultEntityId,
  entities,
}: {
  userEmail?: string;
  defaultEntityId?: string | null;
  entities?: { id: string; name: string }[];
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  // Falls back to the user's default entity ONLY when the URL has no entityId at all —
  // see the DEFAULT ENTITY note above. An entityId already in the URL always wins.
  const entityId = searchParams.get("entityId") ?? defaultEntityId ?? null;
  const [openMenu, setOpenMenu] = useState<"transactions" | "captable" | "reports" | null>(null);
  const navRef = useRef<HTMLElement>(null);

  // Closes an open dropdown on an outside click — without this, clicking anywhere
  // other than a menu item (e.g. to dismiss and keep browsing the current page)
  // would leave the dropdown stuck open.
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (navRef.current && !navRef.current.contains(e.target as Node)) setOpenMenu(null);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <nav
      ref={navRef}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.25rem",
        padding: "0 1rem",
        background: theme.primary,
        fontSize: "0.9rem",
        position: "relative",
      }}
    >
      <Link href="/" style={navLinkStyle} onClick={() => setOpenMenu(null)}>
        Home
      </Link>

      {entities && entities.length > 0 && (
        <select
          aria-label="Switch entity"
          value={entities.some((e) => e.id === entityId) ? (entityId as string) : ""}
          onChange={(e) => {
            const nextEntityId = e.target.value;
            if (nextEntityId) router.push(`/captable?entityId=${nextEntityId}`);
          }}
          style={entitySwitcherStyle}
        >
          {!entities.some((e) => e.id === entityId) && (
            <option value="" disabled>
              Select an entity…
            </option>
          )}
          {entities.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      )}

      <div style={{ position: "relative" }}>
        <button
          type="button"
          onClick={() => setOpenMenu(openMenu === "transactions" ? null : "transactions")}
          style={navButtonStyle(openMenu === "transactions")}
        >
          New transactions ▾
        </button>
        {openMenu === "transactions" && (
          <div style={dropdownStyle}>
            <div style={dropdownColumnsStyle}>
              <div>
                <div style={groupHeadingStyle}>Equity</div>
                <Link
                  href={withEntityId("/instruments/new/stock-award", entityId)}
                  style={{ ...dropdownItemStyle, fontWeight: 600 }}
                  onClick={() => setOpenMenu(null)}
                >
                  Stock award (option, RSU, restricted stock)
                </Link>
                <Link
                  href={withEntityId("/instruments/new/equity-funding", entityId)}
                  style={{ ...dropdownItemStyle, fontWeight: 600 }}
                  onClick={() => setOpenMenu(null)}
                >
                  New Equity Funding (common or preferred)
                </Link>
                {EQUITY_INSTRUMENT_TYPES.map((t) => (
                  <Link
                    key={t.type}
                    href={withEntityId(`/instruments/new?type=${t.type}`, entityId)}
                    style={dropdownItemStyle}
                    onClick={() => setOpenMenu(null)}
                  >
                    {t.label}
                  </Link>
                ))}
                <Link
                  href={withEntityId("/instruments/bulk-upload?type=STOCK_OPTION", entityId)}
                  style={{ ...dropdownItemStyle, borderTop: `1px solid ${theme.border}`, marginTop: "0.25rem", paddingTop: "0.5rem" }}
                  onClick={() => setOpenMenu(null)}
                >
                  Bulk upload stock awards (Excel)
                </Link>
              </div>
              <div>
                <div style={groupHeadingStyle}>Debt</div>
                <Link
                  href={withEntityId("/instruments/new/notes", entityId)}
                  style={{ ...dropdownItemStyle, fontWeight: 600 }}
                  onClick={() => setOpenMenu(null)}
                >
                  Notes (PIK, convertible, or debt + warrants)
                </Link>
                {DEBT_INSTRUMENT_TYPES.map((t) => (
                  <Link
                    key={t.type}
                    href={withEntityId(`/instruments/new?type=${t.type}`, entityId)}
                    style={dropdownItemStyle}
                    onClick={() => setOpenMenu(null)}
                  >
                    {t.label}
                  </Link>
                ))}
              </div>
            </div>
            {!entityId && (
              <div style={dropdownFootnoteStyle}>
                No entity selected yet, and no default entity set — pick one from the home page first (or set a
                default there), or you'll be asked to on the next screen.
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ position: "relative" }}>
        <button
          type="button"
          onClick={() => setOpenMenu(openMenu === "captable" ? null : "captable")}
          style={navButtonStyle(openMenu === "captable")}
        >
          Interactive cap table ▾
        </button>
        {openMenu === "captable" && (
          <div style={dropdownStyle}>
            <Link href={withEntityId("/captable", entityId)} style={dropdownItemStyle} onClick={() => setOpenMenu(null)}>
              Cap table
            </Link>
            <Link
              href={withEntityId("/reports/cap-table-waterfall", entityId)}
              style={dropdownItemStyle}
              onClick={() => setOpenMenu(null)}
            >
              Waterfall Analysis
            </Link>
          </div>
        )}
      </div>

      <Link
        href={entityId ? `/entities/${entityId}/board-consents` : "/"}
        style={navLinkStyle}
        onClick={() => setOpenMenu(null)}
      >
        Board consents
      </Link>

      <div style={{ position: "relative" }}>
        <button
          type="button"
          onClick={() => setOpenMenu(openMenu === "reports" ? null : "reports")}
          style={navButtonStyle(openMenu === "reports")}
        >
          GAAP reports ▾
        </button>
        {openMenu === "reports" && (
          <div style={dropdownStyle}>
            {GAAP_REPORT_GROUPS.map((group) => (
              <div key={group.heading} style={{ marginBottom: "0.5rem" }}>
                <div style={groupHeadingStyle}>{group.heading}</div>
                {group.items.map((item) => (
                  <Link
                    key={item.href}
                    href={item.scoped ? withEntityId(item.href, entityId) : item.href}
                    style={dropdownItemStyle}
                    onClick={() => setOpenMenu(null)}
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      <Link href={withEntityId("/reports/tax", entityId)} style={navLinkStyle} onClick={() => setOpenMenu(null)}>
        Tax/compliance reports
      </Link>

      <Link href={withEntityId("/communications", entityId)} style={navLinkStyle} onClick={() => setOpenMenu(null)}>
        Communications
      </Link>

      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.75rem" }}>
        <Link href="/help" style={navLinkStyle} onClick={() => setOpenMenu(null)}>
          Help
        </Link>
        {userEmail && (
          <>
            <span style={{ fontSize: "0.8rem", color: "rgba(255,255,255,0.75)" }}>{userEmail}</span>
            <LogoutButton />
          </>
        )}
      </div>
    </nav>
  );
}

// v0.34.0 — the nav bar itself is a solid `theme.primary` bar (see the "Slate" palette
// in theme.ts), so its own links/buttons use `theme.onPrimary`/translucent-white
// tones rather than the ink/border tokens the rest of the app uses on a light
// background. The dropdown PANELS below are a separate floating surface on `theme.bg`
// and use the normal ink/border tokens like everything else.
const navLinkStyle: React.CSSProperties = {
  padding: "0.7rem 0.6rem",
  color: theme.onPrimary,
  textDecoration: "none",
  whiteSpace: "nowrap",
};

// The entity switcher (v0.36.0) — a native <select> rather than the custom dropdown
// pattern used for "New transactions"/"GAAP reports" above, since a <select> already
// gives free keyboard support and a familiar affordance for "pick one of these", and
// there's no need for the multi-column grouped layout those two custom dropdowns have.
// Sits on the same theme.primary bar, so — like navLinkStyle/navButtonStyle — it uses
// the translucent-white/onPrimary tokens rather than the light-background ink/border
// tokens the rest of the app (including the dropdown PANELS below) uses.
const entitySwitcherStyle: React.CSSProperties = {
  margin: "0 0.4rem",
  padding: "0.4rem 0.6rem",
  background: "rgba(255,255,255,0.12)",
  border: "1px solid rgba(255,255,255,0.3)",
  borderRadius: 6,
  color: theme.onPrimary,
  font: "inherit",
  fontSize: "0.85rem",
  cursor: "pointer",
  maxWidth: 200,
};

function navButtonStyle(active: boolean): React.CSSProperties {
  return {
    padding: "0.7rem 0.6rem",
    background: active ? "rgba(255,255,255,0.12)" : "transparent",
    border: "none",
    borderBottom: active ? `2px solid ${theme.accent}` : "2px solid transparent",
    font: "inherit",
    color: theme.onPrimary,
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}

const dropdownStyle: React.CSSProperties = {
  position: "absolute",
  top: "100%",
  left: 0,
  background: theme.surface,
  border: `1px solid ${theme.border}`,
  borderRadius: 8,
  boxShadow: "0 12px 24px -8px rgba(28,39,51,0.25)",
  padding: "0.75rem",
  zIndex: 20,
  minWidth: 280,
};

const dropdownColumnsStyle: React.CSSProperties = {
  display: "flex",
  gap: "1.5rem",
};

const groupHeadingStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  textTransform: "uppercase",
  letterSpacing: "0.03em",
  color: theme.inkMuted,
  margin: "0.5rem 0 0.25rem",
};

const dropdownItemStyle: React.CSSProperties = {
  display: "block",
  padding: "0.3rem 0.25rem",
  color: theme.ink,
  textDecoration: "none",
  fontSize: "0.85rem",
  whiteSpace: "nowrap",
  borderRadius: 4,
};

const dropdownFootnoteStyle: React.CSSProperties = {
  marginTop: "0.5rem",
  paddingTop: "0.5rem",
  borderTop: `1px solid ${theme.border}`,
  fontSize: "0.75rem",
  color: theme.inkMuted,
  maxWidth: 260,
};
