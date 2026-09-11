"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { theme } from "@/lib/theme";

/**
 * "Set as default" / "★ Default" control for one row of the home page's entity table
 * — see prisma/schema.prisma's doc comment on User.defaultEntityId for the feature
 * this belongs to. Backed by POST /api/users/default-entity. Only ever shows the
 * "Set as default" action for a NON-default entity — the current default just shows a
 * plain, non-interactive "★ Default" label, since un-setting your only default isn't
 * a meaningful action (making a DIFFERENT entity the default is how you'd actually
 * change it, which is exactly what clicking "Set as default" on another row does).
 */
export function SetDefaultEntityButton({ entityId, isDefault }: { entityId: string; isDefault: boolean }) {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");

  if (isDefault) {
    return <span style={{ fontSize: "0.8rem", color: theme.success.fg, fontWeight: 600 }}>★ Default</span>;
  }

  async function handleClick() {
    setStatus("saving");
    try {
      const res = await fetch("/api/users/default-entity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityId }),
      });
      if (!res.ok) {
        setStatus("error");
        return;
      }
      router.refresh();
    } catch {
      setStatus("error");
    }
  }

  return (
    <button type="button" onClick={handleClick} disabled={status === "saving"} style={linkButtonStyle}>
      {status === "saving" ? "Setting…" : status === "error" ? "Failed — retry?" : "Set as default"}
    </button>
  );
}

const linkButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: theme.accent,
  cursor: "pointer",
  padding: 0,
  fontSize: "0.8rem",
  textDecoration: "underline",
};
