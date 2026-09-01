/**
 * A minimal, dependency-free fixed-point decimal type for exact money and share-count
 * arithmetic, built on BigInt.
 *
 * WHY THIS FILE EXISTS: this engine should use `decimal.js` (or an equivalent
 * arbitrary-precision library) in production — it's the standard, battle-tested choice,
 * and everywhere else in this codebase assumes that API shape. This file is a drop-in
 * replacement written because the sandbox this code was built in has no outbound access
 * to the npm registry, so `decimal.js` could not actually be installed and verified here.
 * The API surface below (`new Decimal(x)`, plus/minus/times/div/comparisons/abs/negated/
 * pow/max) mirrors decimal.js closely enough that swapping the import in this one file —
 * and deleting it — is the only change needed once you're building somewhere with normal
 * package access. Don't build new functionality on top of this file's internals; it
 * exists to be replaced.
 *
 * Internal precision: 16 decimal digits, rounded half-up on every multiply/divide.
 * Far more precision than money math needs (2 decimal places), but enough headroom that
 * intermediate steps in a multi-period schedule don't compound rounding error before the
 * final `.toFixed(2)` at the reporting boundary.
 */

const SCALE = 16;
const SCALE_FACTOR = 10n ** BigInt(SCALE);

export type DecimalValue = FixedDecimal | number | string;

function bigIntDivRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("Division by zero");
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = n / d;
  const remainder = n % d;
  const rounded = remainder * 2n >= d ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/** Formats a raw scaled-BigInt back into a plain decimal string, e.g. for internal
 * round-tripping through the public constructor after an arithmetic operation. */
function formatRaw(raw: bigint): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const s = abs.toString().padStart(SCALE + 1, "0");
  const intPart = s.slice(0, s.length - SCALE);
  const fracPart = s.slice(s.length - SCALE);
  return `${negative ? "-" : ""}${intPart}.${fracPart}`;
}

function parseToRaw(v: DecimalValue): bigint {
  if (v instanceof FixedDecimal) return v.raw;
  let s = typeof v === "number" ? v.toString() : v.trim();
  if (s === "") throw new Error("Cannot create a decimal from an empty string");
  if (/e/i.test(s)) s = Number(s).toFixed(SCALE); // normalize exponential notation
  const negative = s.startsWith("-");
  if (negative) s = s.slice(1);
  const [intPartRaw, fracPartRaw = ""] = s.split(".");
  const intPart = intPartRaw === "" ? "0" : intPartRaw;
  const fracPart = (fracPartRaw + "0".repeat(SCALE)).slice(0, SCALE);
  let raw = BigInt(intPart) * SCALE_FACTOR + BigInt(fracPart);
  if (negative) raw = -raw;
  return raw;
}

export class FixedDecimal {
  private readonly raw: bigint;

  /** Mirrors decimal.js's `new Decimal(value)` usage throughout this codebase. */
  constructor(v: DecimalValue) {
    this.raw = parseToRaw(v);
  }

  /** Builds an instance directly from a raw scaled BigInt via a round-trip through the
   * public constructor — keeps this class free of a second, easy-to-misuse constructor
   * signature, at the cost of one string format/parse per arithmetic op (irrelevant at
   * this scale of computation). */
  private static fromRaw(raw: bigint): FixedDecimal {
    return new FixedDecimal(formatRaw(raw));
  }

  static from(v: DecimalValue): FixedDecimal {
    return v instanceof FixedDecimal ? v : new FixedDecimal(v);
  }

  plus(v: DecimalValue): FixedDecimal {
    return FixedDecimal.fromRaw(this.raw + FixedDecimal.from(v).raw);
  }

  minus(v: DecimalValue): FixedDecimal {
    return FixedDecimal.fromRaw(this.raw - FixedDecimal.from(v).raw);
  }

  times(v: DecimalValue): FixedDecimal {
    return FixedDecimal.fromRaw(bigIntDivRound(this.raw * FixedDecimal.from(v).raw, SCALE_FACTOR));
  }

  div(v: DecimalValue): FixedDecimal {
    return FixedDecimal.fromRaw(bigIntDivRound(this.raw * SCALE_FACTOR, FixedDecimal.from(v).raw));
  }

  negated(): FixedDecimal {
    return FixedDecimal.fromRaw(-this.raw);
  }

  abs(): FixedDecimal {
    return FixedDecimal.fromRaw(this.raw < 0n ? -this.raw : this.raw);
  }

  isNegative(): boolean {
    return this.raw < 0n;
  }

  isZero(): boolean {
    return this.raw === 0n;
  }

  /** Non-negative integer exponent only (period counts, squaring) — every call site in
   * this codebase needs exactly that, never a fractional or negative power. */
  pow(exponent: number): FixedDecimal {
    if (!Number.isInteger(exponent) || exponent < 0) {
      throw new Error("FixedDecimal.pow only supports non-negative integer exponents");
    }
    let result = new FixedDecimal(1);
    let base: FixedDecimal = this;
    let e = exponent;
    while (e > 0) {
      if (e & 1) result = result.times(base);
      base = base.times(base);
      e >>= 1;
    }
    return result;
  }

  equals(v: DecimalValue): boolean {
    return this.raw === FixedDecimal.from(v).raw;
  }
  greaterThan(v: DecimalValue): boolean {
    return this.raw > FixedDecimal.from(v).raw;
  }
  greaterThanOrEqualTo(v: DecimalValue): boolean {
    return this.raw >= FixedDecimal.from(v).raw;
  }
  lessThan(v: DecimalValue): boolean {
    return this.raw < FixedDecimal.from(v).raw;
  }
  lessThanOrEqualTo(v: DecimalValue): boolean {
    return this.raw <= FixedDecimal.from(v).raw;
  }

  toNumber(): number {
    return Number(this.raw) / Number(SCALE_FACTOR);
  }

  toFixed(decimalPlaces = 2): string {
    const negative = this.raw < 0n;
    const [intPart, fracPart] = formatRaw(this.raw < 0n ? -this.raw : this.raw).split(".");
    let finalInt = intPart;
    let finalFrac: string;
    if (decimalPlaces >= SCALE) {
      finalFrac = fracPart.padEnd(decimalPlaces, "0");
    } else {
      const roundedFracRaw = bigIntDivRound(BigInt(fracPart), 10n ** BigInt(SCALE - decimalPlaces));
      // Compare numerically against 10^decimalPlaces to detect a carry, rather than by
      // string length: at decimalPlaces === 0, a NON-carrying result is 0, whose
      // toString() is "0" (length 1, same length "1" — an actual carry — would have),
      // so the old length-based comparison ("0".padStart(0, "0") is still "0", length 1
      // > 0) treated every non-carrying rounding as a carry, incrementing the integer
      // part unconditionally. Bug found via optionSettlement.ts's whole-share rounding,
      // the first caller in this codebase to ever pass decimalPlaces: 0.
      const carryThreshold = 10n ** BigInt(decimalPlaces);
      let finalFracRaw = roundedFracRaw;
      if (roundedFracRaw >= carryThreshold) {
        // Rounding carried into the integer part, e.g. 0.999 -> 1.00
        finalInt = (BigInt(intPart) + 1n).toString();
        finalFracRaw = roundedFracRaw - carryThreshold;
      }
      finalFrac = decimalPlaces > 0 ? finalFracRaw.toString().padStart(decimalPlaces, "0") : "";
    }
    const isEffectivelyZero = finalInt.replace(/^0+/, "") === "" && !/[1-9]/.test(finalFrac);
    const sign = negative && !isEffectivelyZero ? "-" : "";
    return decimalPlaces > 0 ? `${sign}${finalInt}.${finalFrac}` : `${sign}${finalInt}`;
  }

  toString(): string {
    const fixed = this.toFixed(SCALE);
    return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
  }

  static max(...vals: DecimalValue[]): FixedDecimal {
    return vals.map(FixedDecimal.from).reduce((a, b) => (a.greaterThanOrEqualTo(b) ? a : b));
  }

  /** Added in v0.20.0 for `beneficialConversionFeature.ts`'s cap-at-allocated-proceeds
   * rule (ASC 470-20-30-8) — needed a `min` the same shape as the `max` above, which
   * had no counterpart until now even though nothing about `max`'s implementation is
   * specific to "max." */
  static min(...vals: DecimalValue[]): FixedDecimal {
    return vals.map(FixedDecimal.from).reduce((a, b) => (a.lessThanOrEqualTo(b) ? a : b));
  }
}
