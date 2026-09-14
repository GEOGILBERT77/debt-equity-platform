"use client";

import { useState } from "react";
import { theme } from "@/lib/theme";
import { StakeholderDocumentsPanel } from "@/app/components/StakeholderDocumentsPanel";

/**
 * A small "Documents" button that opens StakeholderDocumentsPanel for one stakeholder
 * — self-contained (owns its own open/close state) so it can drop into a table cell
 * (captable/page.tsx's "All instruments (detail)" table, investors/contacts's table)
 * with no page-level state wiring. See StakeholderDocumentsPanel's own doc comment for
 * why the panel itself is read-only and deep-links to the document library to upload.
 */
export function StakeholderDocumentsTrigger({
  entityId,
  stakeholderId,
  stakeholderName,
}: {
  entityId: string;
  stakeholderId: string;
  stakeholderName: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          fontSize: "0.8rem",
          color: theme.accent,
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: 0,
          textDecoration: "underline",
        }}
      >
        Documents
      </button>
      <StakeholderDocumentsPanel
        entityId={entityId}
        stakeholderId={stakeholderId}
        stakeholderName={stakeholderName}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
