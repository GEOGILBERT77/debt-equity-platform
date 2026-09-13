"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { theme } from "@/lib/theme";

const STAKEHOLDER_TYPES = ["INVESTOR", "DEBT_HOLDER", "EMPLOYEE", "ADVISOR", "ENTITY_HOLDER"] as const;
const INVESTOR_TYPES = ["INDIVIDUAL", "INSTITUTION"] as const;

/**
 * The actual interactive form for stakeholders/new/page.tsx (v0.36.0) — split out of
 * that page so the page itself could become a server component and pick up the same
 * "fall back to the user's default entity" redirect every other entity-scoped page has
 * had since v0.21.0 (see instruments/new/page.tsx's doc comment for the original
 * pattern this mirrors: a server component wrapper handling entityId/redirect, handing
 * off to a client component for the actual form). `entityId` is now a required prop
 * rather than read from `useSearchParams()` directly, since the wrapper page has
 * already resolved and validated it before this component ever renders.
 *
 * v0.44.0 — added Phone/Mailing address (the API already accepted both — see POST
 * .../stakeholders — but this form never exposed them, so they were only ever
 * settable via direct SQL) plus the two new "Investor Contacts" fields, Investor type
 * and Point of contact. The latter two only render when the selected Type is INVESTOR
 * or ENTITY_HOLDER — the two StakeholderTypes that represent a capital-providing
 * investor rather than an employee/advisor/lender (see InvestorType's own doc comment
 * in prisma/schema.prisma) — same "show only what applies to the current choice"
 * pattern already used elsewhere in this app (e.g. EquityCompDisclosuresCalculator.tsx's
 * mode-specific fieldsets). Point of contact defaults to whatever's typed into Name,
 * on the theory that an INDIVIDUAL investor is their own point of contact; switching to
 * INSTITUTION (or just editing the field) overrides that default with a real person's
 * name, e.g. the institution's own name in Name plus "Jane Doe, Managing Partner" here.
 */
export function NewStakeholderForm({ entityId }: { entityId: string }) {
  const router = useRouter();

  const [name, setName] = useState("");
  const [type, setType] = useState<(typeof STAKEHOLDER_TYPES)[number]>("INVESTOR");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [investorType, setInvestorType] = useState<"" | (typeof INVESTOR_TYPES)[number]>("");
  const [contactName, setContactName] = useState("");
  const [contactNameTouched, setContactNameTouched] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const showInvestorFields = type === "INVESTOR" || type === "ENTITY_HOLDER";
  // Point of contact tracks Name until the user types into it directly — see the doc
  // comment above for why (an individual investor is their own point of contact).
  const contactNameValue = contactNameTouched ? contactName : name;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("loading");
    setMessage(null);
    try {
      const res = await fetch(`/api/entities/${entityId}/stakeholders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          type,
          email: email || undefined,
          phone: phone || undefined,
          address: address || undefined,
          investorType: showInvestorFields ? investorType || undefined : undefined,
          contactName: showInvestorFields ? contactNameValue || undefined : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setMessage(data.error ?? "Failed to create stakeholder");
        return;
      }
      router.push(`/instruments/new?entityId=${entityId}&stakeholderId=${data.stakeholder.id}`);
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Failed to create stakeholder");
    }
  }

  return (
    <main style={{ fontFamily: theme.font.body, padding: "2rem", maxWidth: 500 }}>
      <p>
        <Link href={`/captable?entityId=${entityId}`}>&larr; Cap table</Link>
      </p>
      <h1>New stakeholder</h1>
      <form onSubmit={handleSubmit}>
        <label style={labelStyle}>
          Name
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} required style={inputStyle} />
        </label>
        <label style={labelStyle}>
          Type
          <select value={type} onChange={(e) => setType(e.target.value as typeof type)} style={inputStyle}>
            {STAKEHOLDER_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label style={labelStyle}>
          Email (optional)
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} style={inputStyle} />
        </label>
        <label style={labelStyle}>
          Phone (optional)
          <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} style={inputStyle} />
        </label>
        <label style={labelStyle}>
          Mailing address (optional)
          <textarea value={address} onChange={(e) => setAddress(e.target.value)} rows={2} style={{ ...inputStyle, resize: "vertical" }} />
        </label>

        {showInvestorFields && (
          <>
            <label style={labelStyle}>
              Investor type (optional)
              <select value={investorType} onChange={(e) => setInvestorType(e.target.value as typeof investorType)} style={inputStyle}>
                <option value="">Not set</option>
                <option value="INDIVIDUAL">Individual</option>
                <option value="INSTITUTION">Institution</option>
              </select>
            </label>
            <label style={labelStyle}>
              Point of contact (optional)
              <input
                type="text"
                value={contactNameValue}
                onChange={(e) => {
                  setContactNameTouched(true);
                  setContactName(e.target.value);
                }}
                placeholder="Defaults to Name above"
                style={inputStyle}
              />
            </label>
          </>
        )}

        <button type="submit" disabled={status === "loading"} style={buttonStyle}>
          {status === "loading" ? "Creating…" : "Create stakeholder, then add an instrument"}
        </button>
        {message && <p style={{ color: theme.danger.fg, marginTop: "0.5rem" }}>{message}</p>}
      </form>
    </main>
  );
}

const buttonStyle: React.CSSProperties = {
  padding: "0.5rem 1rem",
  border: `1px solid ${theme.ink}`,
  borderRadius: 4,
  background: theme.surfaceAlt,
  cursor: "pointer",
};
const labelStyle: React.CSSProperties = { display: "block", margin: "0.75rem 0", fontSize: "0.9rem" };
const inputStyle: React.CSSProperties = { display: "block", width: "100%", padding: "0.4rem", marginTop: "0.25rem" };
