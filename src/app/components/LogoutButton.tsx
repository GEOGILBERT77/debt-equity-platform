"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function LogoutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleLogout() {
    setLoading(true);
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    router.push("/login");
    router.refresh();
  }

  return (
    <button
      onClick={handleLogout}
      disabled={loading}
      style={{
        padding: "0.3rem 0.7rem",
        border: "1px solid #999",
        borderRadius: 4,
        background: "#fff",
        cursor: "pointer",
        fontSize: "0.85rem",
      }}
    >
      {loading ? "Signing out…" : "Sign out"}
    </button>
  );
}
