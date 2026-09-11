import * as XLSX from "xlsx";
import { db } from "@/lib/db";
import { generateStandardMonthlyTranches } from "@/lib/accounting/vesting";
import { validateInstrumentTerms, TermsValidationError } from "@/lib/accounting/termsValidation";

/**
 * Bulk grant upload from an Excel template — v0.23.0, generalized from an
 * originally STOCK_OPTION-only importer per direct follow-up: "any user input screen
 * should also have an excel template option that can handle one or multiple
 * instruments of that kind." Covers the three instrument types that share the exact
 * same "service condition" shape (ServiceConditionGrant / RestrictedStockInstrumentTerms
 * in dispatch.ts) and therefore the exact same STANDARD-VESTING bulk-upload design —
 * see BULK-UPLOAD-PLAN.md at the repo root for why the remaining instrument types
 * (debt, warrants, preferred stock) need genuinely different template designs rather
 * than one universal spreadsheet shape, and aren't covered by this module.
 *
 * TEMPLATE DESIGN: one ROW PER GRANTEE (not one row per tranche) — the template only
 * asks for a STANDARD vesting shape (total months + cliff months) per row rather than
 * a full tranche list; `generateStandardMonthlyTranches` (vesting.ts) turns those two
 * numbers into the actual tranche array. A grantee whose vesting genuinely isn't
 * standard still needs to go through the regular "New transactions" form's manual
 * tranche entry — this importer deliberately doesn't try to express that in a cell.
 *
 * REQUIRES the `xlsx` (SheetJS) package — added to package.json's dependencies; run
 * `npm install` after merging this if it isn't already present.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file that imports `db`.
 */

export const SERVICE_CONDITION_TYPES = ["STOCK_OPTION", "RSU", "RESTRICTED_STOCK"] as const;
export type ServiceConditionType = (typeof SERVICE_CONDITION_TYPES)[number];

export function isServiceConditionType(value: string): value is ServiceConditionType {
  return (SERVICE_CONDITION_TYPES as readonly string[]).includes(value);
}

const BASE_REQUIRED_COLUMNS = ["Grantee name", "Grant date", "Quantity", "Grant date fair value per share", "Vesting months"] as const;

const VALID_STAKEHOLDER_TYPES = ["INVESTOR", "DEBT_HOLDER", "EMPLOYEE", "ADVISOR", "ENTITY_HOLDER"] as const;

export interface ParsedGrantRow {
  rowNumber: number; // 1-based, matching what the user sees in Excel (header is row 1)
  granteeName: string;
  granteeEmail: string | null;
  granteeType: (typeof VALID_STAKEHOLDER_TYPES)[number];
  grantDate: string; // ISODate
  quantity: number;
  grantDateFairValuePerUnit: number;
  vestingMonths: number;
  cliffMonths: number;
  attributionMethod: "straight-line" | "graded";
  /** Only meaningful for RESTRICTED_STOCK — ignored for STOCK_OPTION/RSU. */
  purchasePricePerShare: number;
  /** Required, only meaningful, for STOCK_OPTION — disclosure only (see
   * ServiceConditionGrant.strikePrice's doc comment in vesting.ts). null for RSU/
   * RESTRICTED_STOCK rows, which don't have a strike. */
  strikePrice: number | null;
  /** Optional for every type — see ServiceConditionGrant.servicePeriodEndDate's doc
   * comment in vesting.ts. null means "same as the last vesting tranche," the
   * ordinary case. */
  servicePeriodEndDate: string | null;
}

export interface RowError {
  rowNumber: number;
  message: string;
}

function coerceISODate(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  return null;
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) return Number(value);
  return null;
}

/** Parses the uploaded workbook's first sheet into rows, validating each cell's shape
 * (not yet touching the database — see importParsedGrantRows for that). A workbook
 * missing a required column fails immediately for the whole file (that's a template
 * problem, not a per-row one); a bad value in one row is collected as a per-row error
 * so the rest of the file can still import. */
export function parseServiceConditionUploadWorkbook(
  buffer: ArrayBuffer,
  type: ServiceConditionType
): { rows: ParsedGrantRow[]; errors: RowError[] } {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error("The uploaded file has no sheets.");
  }
  const sheet = workbook.Sheets[sheetName];
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });

  if (raw.length === 0) {
    throw new Error("No data rows found — the template's first sheet is empty below the header row.");
  }

  const requiredColumns: readonly string[] =
    type === "RESTRICTED_STOCK"
      ? [...BASE_REQUIRED_COLUMNS, "Purchase price per share"]
      : type === "STOCK_OPTION"
        ? [...BASE_REQUIRED_COLUMNS, "Strike price"]
        : BASE_REQUIRED_COLUMNS;
  // "Service period end date" is deliberately NOT in any required-columns list — it's
  // optional for every type (see ServiceConditionGrant.servicePeriodEndDate's doc
  // comment in vesting.ts), so a template saved before this column existed, or a row
  // that just leaves it blank, is still a valid upload.
  const headerRow = raw[0];
  const missingColumns = requiredColumns.filter((col) => !(col in headerRow));
  if (missingColumns.length > 0) {
    throw new Error(
      `Missing required column(s): ${missingColumns.join(", ")}. Use the provided template without renaming its header row.`
    );
  }

  const rows: ParsedGrantRow[] = [];
  const errors: RowError[] = [];

  raw.forEach((record, i) => {
    const rowNumber = i + 2; // +1 for 0-index, +1 because row 1 is the header
    const issues: string[] = [];

    const granteeName = typeof record["Grantee name"] === "string" ? (record["Grantee name"] as string).trim() : "";
    if (!granteeName) issues.push("Grantee name is required");

    const granteeEmailRaw = record["Grantee email"];
    const granteeEmail = typeof granteeEmailRaw === "string" && granteeEmailRaw.trim() ? granteeEmailRaw.trim() : null;

    const granteeTypeRaw = typeof record["Grantee type"] === "string" ? (record["Grantee type"] as string).trim().toUpperCase() : "";
    const granteeType = (granteeTypeRaw || "EMPLOYEE") as (typeof VALID_STAKEHOLDER_TYPES)[number];
    if (!VALID_STAKEHOLDER_TYPES.includes(granteeType)) {
      issues.push(`Grantee type "${granteeTypeRaw}" must be one of: ${VALID_STAKEHOLDER_TYPES.join(", ")} (or left blank for EMPLOYEE)`);
    }

    const grantDate = coerceISODate(record["Grant date"]);
    if (!grantDate) issues.push('Grant date is required and must be a valid date (e.g. "2026-03-01")');

    const quantity = coerceNumber(record["Quantity"]);
    if (quantity === null || quantity <= 0 || !Number.isInteger(quantity)) {
      issues.push("Quantity is required and must be a positive whole number");
    }

    const grantDateFairValuePerUnit = coerceNumber(record["Grant date fair value per share"]);
    if (grantDateFairValuePerUnit === null || grantDateFairValuePerUnit <= 0) {
      issues.push("Grant date fair value per share is required and must be a positive number");
    }

    const vestingMonths = coerceNumber(record["Vesting months"]);
    if (vestingMonths === null || vestingMonths <= 0 || !Number.isInteger(vestingMonths)) {
      issues.push("Vesting months is required and must be a positive whole number");
    }

    const cliffMonthsRaw = record["Cliff months"];
    const cliffMonths = cliffMonthsRaw === null || cliffMonthsRaw === undefined || cliffMonthsRaw === "" ? 0 : coerceNumber(cliffMonthsRaw);
    if (cliffMonths === null || cliffMonths < 0 || !Number.isInteger(cliffMonths)) {
      issues.push("Cliff months must be a non-negative whole number (or left blank for 0)");
    } else if (vestingMonths !== null && cliffMonths > vestingMonths) {
      issues.push("Cliff months cannot be greater than Vesting months");
    }

    const attributionRaw = typeof record["Attribution method"] === "string" ? (record["Attribution method"] as string).trim().toLowerCase() : "";
    const attributionMethod = (attributionRaw || "straight-line") as "straight-line" | "graded";
    if (attributionMethod !== "straight-line" && attributionMethod !== "graded") {
      issues.push('Attribution method must be "straight-line" or "graded" (or left blank for straight-line)');
    }

    let purchasePricePerShare = 0;
    if (type === "RESTRICTED_STOCK") {
      const raw = coerceNumber(record["Purchase price per share"]);
      if (raw === null || raw < 0) {
        issues.push("Purchase price per share is required for restricted stock and must be zero or a positive number");
      } else {
        purchasePricePerShare = raw;
      }
    }

    let strikePrice: number | null = null;
    if (type === "STOCK_OPTION") {
      const raw = coerceNumber(record["Strike price"]);
      if (raw === null || raw <= 0) {
        issues.push("Strike price is required for stock options and must be a positive number");
      } else {
        strikePrice = raw;
      }
    }

    // Optional for every type — blank/missing is the ordinary case (same as the last
    // vesting tranche). A cell that IS filled in but isn't a parseable date is still a
    // row error, same treatment as every other date column here.
    const servicePeriodEndDateRaw = record["Service period end date"];
    let servicePeriodEndDate: string | null = null;
    if (servicePeriodEndDateRaw !== null && servicePeriodEndDateRaw !== undefined && servicePeriodEndDateRaw !== "") {
      servicePeriodEndDate = coerceISODate(servicePeriodEndDateRaw);
      if (!servicePeriodEndDate) {
        issues.push('Service period end date must be a valid date (e.g. "2032-01-01") when provided, or left blank');
      } else if (grantDate && servicePeriodEndDate <= grantDate) {
        issues.push("Service period end date must be after Grant date");
      }
    }

    if (issues.length > 0) {
      errors.push({ rowNumber, message: issues.join("; ") });
      return;
    }

    rows.push({
      rowNumber,
      granteeName,
      granteeEmail,
      granteeType,
      grantDate: grantDate!,
      quantity: quantity!,
      grantDateFairValuePerUnit: grantDateFairValuePerUnit!,
      vestingMonths: vestingMonths!,
      cliffMonths: cliffMonths!,
      attributionMethod,
      purchasePricePerShare,
      strikePrice,
      servicePeriodEndDate,
    });
  });

  return { rows, errors };
}

export interface ImportRowResult {
  rowNumber: number;
  status: "created" | "error";
  granteeName: string;
  instrumentId?: string;
  message?: string;
}

/** Imports already-parsed rows into the database: finds-or-creates each grantee as a
 * Stakeholder (matched by name, case-insensitively), generates the standard tranches,
 * builds the terms shape the given TYPE actually expects (RESTRICTED_STOCK gets the
 * extra `purchasePricePerShare` field; STOCK_OPTION/RSU don't), validates through the
 * exact same `validateInstrumentTerms` the manual "New transactions" form's API route
 * uses, and creates the Instrument. One database transaction PER ROW (not one for the
 * whole file) — same "flag rather than crash" reasoning as closeAllInstrumentsForEntity:
 * a bad row should never block every OTHER grantee in the same file from importing.
 *
 * Does NOT generate or approve an amortization schedule for the created instruments —
 * per the "approve before going live" requirement, a bulk upload gets exactly ONE
 * approval gate covering the whole batch, not a per-row auto-generation. The bulk
 * upload UI shows this batch's results, then a single "Approve all uploaded grants"
 * action (POST /api/entities/:id/amortization-schedule/approve-all) puts the whole
 * batch live at once — see BulkUploadStockOptionsForm.tsx. */
export async function importParsedGrantRows(
  entityId: string,
  type: ServiceConditionType,
  rows: ParsedGrantRow[],
  createdByUserId: string
): Promise<ImportRowResult[]> {
  const results: ImportRowResult[] = [];

  for (const row of rows) {
    try {
      const tranches = generateStandardMonthlyTranches({
        grantDate: row.grantDate,
        quantity: row.quantity,
        vestingMonths: row.vestingMonths,
        cliffMonths: row.cliffMonths,
      });

      const baseTerms = {
        grantDate: row.grantDate,
        quantity: row.quantity,
        grantDateFairValuePerUnit: row.grantDateFairValuePerUnit,
        attributionMethod: row.attributionMethod,
        tranches,
        ...(row.servicePeriodEndDate ? { servicePeriodEndDate: row.servicePeriodEndDate } : {}),
      };
      const terms =
        type === "RESTRICTED_STOCK"
          ? { ...baseTerms, purchasePricePerShare: row.purchasePricePerShare }
          : type === "STOCK_OPTION"
            ? { ...baseTerms, strikePrice: row.strikePrice }
            : baseTerms;

      try {
        validateInstrumentTerms(type, terms);
      } catch (err) {
        if (err instanceof TermsValidationError) {
          throw new Error(err.issues.map((i) => `${i.path || "(root)"} ${i.message}`).join("; "));
        }
        throw err;
      }

      const instrument = await db.$transaction(async (tx) => {
        let stakeholder = await tx.stakeholder.findFirst({
          where: { entityId, name: { equals: row.granteeName, mode: "insensitive" } },
        });
        if (!stakeholder) {
          stakeholder = await tx.stakeholder.create({
            data: {
              entityId,
              name: row.granteeName,
              type: row.granteeType,
              email: row.granteeEmail ?? undefined,
            },
          });
        }

        return tx.instrument.create({
          data: {
            entityId,
            stakeholderId: stakeholder.id,
            type,
            issueDate: new Date(row.grantDate),
            termVersions: {
              create: [{ effectiveDate: new Date(row.grantDate), label: "Original terms (bulk upload)", terms, createdByUserId }],
            },
          },
        });
      });

      results.push({ rowNumber: row.rowNumber, status: "created", granteeName: row.granteeName, instrumentId: instrument.id });
    } catch (err) {
      results.push({
        rowNumber: row.rowNumber,
        status: "error",
        granteeName: row.granteeName,
        message: err instanceof Error ? err.message : "Failed to import this row",
      });
    }
  }

  return results;
}
