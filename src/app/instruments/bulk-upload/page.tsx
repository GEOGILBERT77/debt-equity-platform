import Link from "next/link";
import { redirect } from "next/navigation";
import { theme } from "@/lib/theme";
import { BulkUploadStockOptionsForm } from "@/app/components/BulkUploadStockOptionsForm";
import { isServiceConditionType, SERVICE_CONDITION_TYPES, ServiceConditionType } from "@/lib/db/bulkUploadServiceConditionGrants";
import { requirePageEntityAccess, requireCurrentUser } from "@/lib/auth/pageGuard";

const LABELS: Record<ServiceConditionType, string> = {
  STOCK_OPTION: "stock option",
  RSU: "RSU",
  RESTRICTED_STOCK: "restricted stock",
};

const TEMPLATE_FILES: Record<ServiceConditionType, string> = {
  STOCK_OPTION: "/templates/stock-option-bulk-upload-template.xlsx",
  RSU: "/templates/rsu-bulk-upload-template.xlsx",
  RESTRICTED_STOCK: "/templates/restricted-stock-bulk-upload-template.xlsx",
};

/**
 * Bulk grant upload (v0.23.0) — generalized to cover STOCK_OPTION, RSU, and
 * RESTRICTED_STOCK (the three types sharing a standard-vesting shape — see
 * bulkUploadServiceConditionGrants.ts and BULK-UPLOAD-PLAN.md for the rest). Reached
 * from each of those types' entry in NavBar's "New transactions" menu with `?type=`
 * set accordingly, so this one page serves all three rather than three near-identical
 * copies.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export default async function BulkUploadPage({
  searchParams,
}: {
  searchParams: { entityId?: string; type?: string };
}) {
  const entityId = searchParams.entityId;
  const type = isServiceConditionType(searchParams.type ?? "") ? (searchParams.type as ServiceConditionType) : "STOCK_OPTION";

  if (!entityId) {
    const user = await requireCurrentUser();
    if (user.defaultEntityId) redirect(`/instruments/bulk-upload?entityId=${user.defaultEntityId}&type=${type}`);
    return (
      <main style={{ fontFamily: theme.font.body, padding: "2rem" }}>
        <p>
          Pass <code>?entityId=...</code>, or go to <Link href="/">the entity list</Link> (or set a default
          entity there).
        </p>
      </main>
    );
  }

  await requirePageEntityAccess(entityId, "EDITOR");

  return (
    <main style={{ fontFamily: theme.font.body, padding: "2rem", maxWidth: 700 }}>
      <p>
        <Link href={`/captable?entityId=${entityId}`}>&larr; Cap table</Link>
      </p>
      <h1>Bulk upload {LABELS[type]} grants</h1>
      <p style={{ color: theme.inkMuted }}>
        {SERVICE_CONDITION_TYPES.map((t, i) => (
          <span key={t}>
            {i > 0 && " · "}
            {t === type ? (
              <strong>{LABELS[t]}</strong>
            ) : (
              <Link href={`/instruments/bulk-upload?entityId=${entityId}&type=${t}`}>{LABELS[t]}</Link>
            )}
          </span>
        ))}
      </p>
      <p style={{ color: theme.inkMuted }}>
        For multiple grantees with varying award amounts, on a STANDARD vesting schedule (a total vesting
        period and an optional cliff, vesting monthly thereafter). One row per grantee — a stakeholder that
        doesn't already exist on this entity is created automatically. A grant with non-standard vesting
        (uneven tranches, anything performance-linked) still needs to be entered one at a time from{" "}
        <Link href={`/instruments/new?entityId=${entityId}&type=${type}`}>New transactions</Link> instead.
      </p>
      <p>
        <a href={TEMPLATE_FILES[type]} style={buttonLinkStyle}>
          Download {LABELS[type]} template (.xlsx)
        </a>
      </p>
      <h2>Upload completed template</h2>
      <BulkUploadStockOptionsForm entityId={entityId} type={type} />
    </main>
  );
}

const buttonLinkStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "0.4rem 0.8rem",
  border: `1px solid ${theme.ink}`,
  borderRadius: 4,
  background: theme.surfaceAlt,
  textDecoration: "none",
  color: "inherit",
};
