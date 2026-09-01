import { Money, DecimalValue, money } from "./types.js";

/**
 * Black-Scholes-Merton fair value for a European call option, used under ASC 718
 * to value time- and performance-condition stock options at the grant date.
 *
 * This module works in plain JS `number`, not the exact fixed-point Decimal used
 * everywhere else in this engine — deliberately. A Black-Scholes output is a modeled
 * estimate (volatility and expected term are themselves estimates), not a ledger figure
 * that has to tie out to the cent, so ordinary floating point is the right tool here.
 * The result is wrapped back into a Decimal via `money()` at the boundary, where it
 * re-enters the exact-arithmetic world of the vesting/amortization engines.
 *
 * IMPORTANT SCOPE NOTE: this is appropriate for service-condition and
 * performance-condition awards. Market-condition awards (TSR hurdles, stock-price
 * targets) require a lattice or Monte Carlo model that reflects the path-dependent
 * payoff and cannot be reduced to closed-form Black-Scholes — see vesting.ts for how
 * market-condition fair values are handled (accepted as an external input, not computed
 * here). Don't extend this function to "approximate" a market condition; get that
 * valuation from a 409A/valuation provider instead.
 */
export interface BlackScholesInputs {
  stockPrice: DecimalValue; // current fair value of the underlying share
  strikePrice: DecimalValue; // exercise price
  riskFreeRate: DecimalValue; // annualized, continuously compounded, e.g. 0.045
  volatility: DecimalValue; // annualized, e.g. 0.55
  expectedTermYears: DecimalValue; // expected term, not contractual term
  dividendYield?: DecimalValue; // annualized, default 0
}

/** Abramowitz & Stegun approximation of the standard normal CDF (accurate to ~1e-7). */
function normCdf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

function toNumber(v: DecimalValue): number {
  return typeof v === "number" ? v : typeof v === "string" ? Number(v) : v.toNumber();
}

export function blackScholesCallValue(inputs: BlackScholesInputs): Money {
  const S = toNumber(inputs.stockPrice);
  const K = toNumber(inputs.strikePrice);
  const r = toNumber(inputs.riskFreeRate);
  const q = toNumber(inputs.dividendYield ?? 0);
  const sigma = toNumber(inputs.volatility);
  const T = toNumber(inputs.expectedTermYears);

  if (T <= 0 || sigma <= 0) {
    // Degenerate case: no optionality left, value is pure intrinsic value.
    return money(Math.max(S - K, 0));
  }

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + (sigma * sigma) / 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  const Nd1 = normCdf(d1);
  const Nd2 = normCdf(d2);

  const discountedStock = S * Math.exp(-q * T);
  const discountedStrike = K * Math.exp(-r * T);

  const value = discountedStock * Nd1 - discountedStrike * Nd2;
  return money(Math.max(value, 0));
}
