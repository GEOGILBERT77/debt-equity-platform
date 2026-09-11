"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { theme } from "@/lib/theme";

/** Portal counterpart to LogoutButton.tsx — posts to /api/portal/logout and redirects
 * to /portal/login, never touching the admin session cookie. */
export function PortalLogoutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleLogout() {
    setLoading(true);
    await fetch("/api/portal/logout", { method: "POST" }).catch(() => {});
    router.push("/portal/login");
    router.refresh();
  }

  return (
    <button
      onClick={handleLogout}
      disabled={loading}
      style={{
        padding: "0.3rem 0.7rem",
        border: `1px solid ${theme.border}`,
        borderRadius: 4,
        background: theme.surface,
        cursor: "pointer",
        fontSize: "0.85rem",
      }}
    >
      {loading ? "Signing out…" : "Sign out"}
    </button>
  );
}
