import { NextRequest, NextResponse } from "next/server";
import {
  parseServiceConditionUploadWorkbook,
  importParsedGrantRows,
  isServiceConditionType,
  SERVICE_CONDITION_TYPES,
} from "@/lib/db/bulkUploadServiceConditionGrants";
import { requireApiEntityAccess } from "@/lib/auth/apiGuard";

/**
 * POST /api/entities/:id/instruments/bulk-upload?type=STOCK_OPTION — multipart/
 * form-data with one file field named "file" (an .xlsx built from the matching
 * bulk-upload template — see /instruments/bulk-upload/page.tsx and
 * bulkUploadServiceConditionGrants.ts for the exact column shape). `type` must be one
 * of STOCK_OPTION, RSU, or RESTRICTED_STOCK — the three instrument types this generic
 * importer currently covers (see BULK-UPLOAD-PLAN.md for the rest). EDITOR-or-above,
 * same bar as creating a single instrument.
 *
 * Returns a per-row breakdown (created / error, never a single opaque pass/fail for
 * the whole file) — same reasoning as POST /api/entities/:id/close's per-instrument
 * breakdown. Created instruments are NOT approved for reporting yet — the bulk-upload
 * UI shows these results, then a single "Approve all uploaded grants" action puts the
 * whole batch live at once (see BulkUploadStockOptionsForm.tsx and
 * amortizationSchedule.ts's top-of-file doc comment on why approval is a required
 * gate rather than automatic).
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const access = await requireApiEntityAccess(req, params.id, "EDITOR");
  if (access instanceof NextResponse) return access;

  const type = req.nextUrl.searchParams.get("type") ?? "";
  if (!isServiceConditionType(type)) {
    return NextResponse.json({ error: `type query parameter must be one of: ${SERVICE_CONDITION_TYPES.join(", ")}` }, { status: 400 });
  }

  const formData = await req.formData().catch(() => null);
  const file = formData?.get("file");
  if (!file || typeof file === "string") {
    return NextResponse.json({ error: 'Missing file — upload a single .xlsx file under the field name "file".' }, { status: 400 });
  }

  const buffer = await file.arrayBuffer();

  let parsed;
  try {
    parsed = parseServiceConditionUploadWorkbook(buffer, type);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to read the uploaded file" }, { status: 400 });
  }

  const importResults = await importParsedGrantRows(params.id, type, parsed.rows, access.user.id);

  const parseErrors = parsed.errors.map((e) => ({ rowNumber: e.rowNumber, status: "error" as const, message: e.message }));
  const allResults = [...parseErrors, ...importResults].sort((a, b) => a.rowNumber - b.rowNumber);

  const createdCount = importResults.filter((r) => r.status === "created").length;
  const errorCount = allResults.length - createdCount;

  return NextResponse.json({
    totalRows: allResults.length,
    createdCount,
    errorCount,
    results: allResults,
  });
}
