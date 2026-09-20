/**
 * Money for Sahaya jobs. Every amount in this codebase is an INTEGER NUMBER OF PAISE — never a float of rupees.
 * Razorpay's API is also paise-denominated, so the same integer travels from the worker's quote to the gateway
 * to the worker's wallet without a rounding step anywhere in between.
 *
 * The split, once a job is done:
 *
 *     customer pays  gross   = service + approved reimbursements
 *     platform keeps commission = round(service x pct)        <- service only
 *     worker receives payout  = gross - commission
 *
 * Commission is charged on the WORK, never on parts the worker bought out of their own pocket: taking a cut of a
 * ₹450 tap the worker already paid for would make them poorer for doing the job properly. The invariant
 * `payout + commission === gross` is asserted by computeSettlement and covered by tests/money.test.ts.
 */

export const PAISE_PER_RUPEE = 100;

/** Bounds. A worker cannot bill ₹0 or ₹2,00,000 by fat-fingering the amount field. */
export const MIN_SERVICE_PAISE = 1 * PAISE_PER_RUPEE;               // ₹1
export const MAX_SERVICE_PAISE = 50_000 * PAISE_PER_RUPEE;          // ₹50,000
export const MAX_REIMBURSEMENT_PAISE = 10_000 * PAISE_PER_RUPEE;    // ₹10,000 per receipt
export const MAX_REIMBURSEMENTS_PER_JOB = 5;

export const DEFAULT_COMMISSION_PCT = 10;
export const MAX_COMMISSION_PCT = 30;

/** Platform commission, from RESQ_COMMISSION_PCT. Clamped to 0..30 so a typo cannot eat a worker's earnings. */
export function commissionPct(): number {
  const raw = Number(process.env.RESQ_COMMISSION_PCT);
  if (!Number.isFinite(raw)) return DEFAULT_COMMISSION_PCT;
  return Math.min(MAX_COMMISSION_PCT, Math.max(0, raw));
}

export type Settlement = {
  servicePaise: number;        // the worker's final charge for the work
  reimbursementPaise: number;  // approved receipts, passed through in full
  commissionPct: number;
  commissionPaise: number;     // what the platform keeps
  grossPaise: number;          // what the customer is charged
  payoutPaise: number;         // what the worker receives
};

export class MoneyError extends Error {
  constructor(public code: "service_invalid" | "reimbursement_invalid", message: string) { super(message); }
}

/** Throws MoneyError on out-of-range input; never silently clamps an amount a human typed. */
export function computeSettlement(input: { servicePaise: number; reimbursementPaise?: number; pct?: number }): Settlement {
  const servicePaise = input.servicePaise;
  const reimbursementPaise = input.reimbursementPaise ?? 0;
  if (!Number.isSafeInteger(servicePaise) || servicePaise < MIN_SERVICE_PAISE || servicePaise > MAX_SERVICE_PAISE) {
    throw new MoneyError("service_invalid", `service amount must be a whole number of paise between ${MIN_SERVICE_PAISE} and ${MAX_SERVICE_PAISE}`);
  }
  if (!Number.isSafeInteger(reimbursementPaise) || reimbursementPaise < 0 || reimbursementPaise > MAX_REIMBURSEMENT_PAISE * MAX_REIMBURSEMENTS_PER_JOB) {
    throw new MoneyError("reimbursement_invalid", "reimbursement total out of range");
  }
  const pct = input.pct ?? commissionPct();
  const commissionPaise = Math.round((servicePaise * pct) / 100);
  const grossPaise = servicePaise + reimbursementPaise;
  const payoutPaise = grossPaise - commissionPaise;
  // Guards the one thing that must never drift: money in equals money out.
  if (payoutPaise + commissionPaise !== grossPaise) throw new MoneyError("service_invalid", "settlement does not balance");
  return { servicePaise, reimbursementPaise, commissionPct: pct, commissionPaise, grossPaise, payoutPaise };
}

/** "₹1,234.50" — two decimals only when there are non-zero paise, which is how Indian invoices read. */
export function formatPaise(paise: number): string {
  const neg = paise < 0;
  const abs = Math.abs(Math.round(paise));
  const rupees = Math.floor(abs / PAISE_PER_RUPEE);
  const rem = abs % PAISE_PER_RUPEE;
  const body = rupees.toLocaleString("en-IN") + (rem ? `.${String(rem).padStart(2, "0")}` : "");
  return `${neg ? "-" : ""}₹${body}`;
}

/** Parse a rupee amount a human typed ("450", "450.50", "₹1,200") into paise. null if it is not a usable amount. */
export function parseRupeesToPaise(input: unknown): number | null {
  if (typeof input === "number") return Number.isFinite(input) ? Math.round(input * PAISE_PER_RUPEE) : null;
  if (typeof input !== "string") return null;
  const cleaned = input.replace(/[₹,\s]/g, "");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * PAISE_PER_RUPEE);
}
