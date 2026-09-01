import EmbeddedDerivativeBifurcationCalculator from "@/app/components/EmbeddedDerivativeBifurcationCalculator";
import Link from "next/link";

/**
 * ASC 815-15-25 embedded conversion feature bifurcation calculator (v0.20.0) — same
 * thin server-wrapper-around-a-client-component pattern as the other calculator
 * pages. See embeddedDerivativeBifurcation.ts's module doc comment for the full
 * mechanics: the ASC 815-10-15-74 scope exception for a conversion feature that
 * would be equity-classified if freestanding, reusing warrantAllocation.ts's
 * existing classifyWarrant rather than a second indexation analysis.
 *
 * This is a CLASSIFICATION triage only, same "starting hypothesis, not a final
 * answer" caveat classifyWarrant itself carries — and it does not value a
 * derivative that comes back REQUIRED to bifurcate; that needs a lattice or Monte
 * Carlo model, a meaningfully larger undertaking this codebase does not build. See
 * the module doc comment for the rest of what's deliberately out of scope.
 *
 * NOT EXECUTED IN THIS SANDBOX — same caveat as every other file under src/app/.
 */
export default function EmbeddedDerivativeBifurcationPage() {
  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 1000 }}>
      <p>
        <Link href="/">&larr; All entities</Link>
      </p>
      <h1>Embedded derivative bifurcation calculator</h1>
      <p style={{ color: "#555" }}>
        Assesses whether a conversion feature embedded in a debt host must be bifurcated and accounted for
        separately as a derivative (ASC 815-15-25), applying the ASC 815-10-15-74 scope exception that makes
        plain-vanilla convertible debt's conversion feature almost never bifurcated in practice. This is a
        classification triage, not a valuation engine — see embeddedDerivativeBifurcation.ts for the full scope
        note, including what's deliberately out of scope.
      </p>
      <EmbeddedDerivativeBifurcationCalculator />
    </main>
  );
}
