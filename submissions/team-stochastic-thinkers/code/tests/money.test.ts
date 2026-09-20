import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_COMMISSION_PCT, MAX_COMMISSION_PCT, MAX_REIMBURSEMENT_PAISE, MAX_SERVICE_PAISE, MIN_SERVICE_PAISE,
  MoneyError, commissionPct, computeSettlement, formatPaise, parseRupeesToPaise,
} from "../lib/money";

test("the split balances: payout + commission always equals what the customer pays", () => {
  for (const service of [100, 4_500_00, 12_345, 999_99, MAX_SERVICE_PAISE]) {
    for (const parts of [0, 1, 450_00, MAX_REIMBURSEMENT_PAISE]) {
      for (const pct of [0, 5, 10, 12.5, 30]) {
        const s = computeSettlement({ servicePaise: service, reimbursementPaise: parts, pct });
        assert.equal(s.grossPaise, service + parts);
        assert.equal(s.payoutPaise + s.commissionPaise, s.grossPaise, `${service}/${parts}/${pct} does not balance`);
        assert.ok(Number.isSafeInteger(s.commissionPaise) && Number.isSafeInteger(s.payoutPaise));
      }
    }
  }
});

test("commission is charged on the work only, never on parts the worker paid for", () => {
  const withoutParts = computeSettlement({ servicePaise: 1_000_00, reimbursementPaise: 0, pct: 10 });
  const withParts = computeSettlement({ servicePaise: 1_000_00, reimbursementPaise: 450_00, pct: 10 });
  assert.equal(withoutParts.commissionPaise, 100_00);
  assert.equal(withParts.commissionPaise, 100_00, "buying parts must not increase the platform's cut");
  // The worker is made whole on the parts: the extra they receive is exactly what they spent.
  assert.equal(withParts.payoutPaise - withoutParts.payoutPaise, 450_00);
});

test("a worked example reads the way the receipt does", () => {
  const s = computeSettlement({ servicePaise: 800_00, reimbursementPaise: 250_00, pct: 10 });
  assert.equal(s.grossPaise, 1_050_00);   // customer pays ₹1,050
  assert.equal(s.commissionPaise, 80_00); // platform keeps ₹80
  assert.equal(s.payoutPaise, 970_00);    // worker receives ₹970
});

test("out-of-range amounts throw rather than being silently clamped", () => {
  const bad = [0, -1, MIN_SERVICE_PAISE - 1, MAX_SERVICE_PAISE + 1, 12.5, NaN, Infinity];
  for (const v of bad) {
    assert.throws(() => computeSettlement({ servicePaise: v }), MoneyError, `${v} should be rejected`);
  }
  assert.throws(() => computeSettlement({ servicePaise: 500_00, reimbursementPaise: -1 }), MoneyError);
  assert.throws(() => computeSettlement({ servicePaise: 500_00, reimbursementPaise: MAX_REIMBURSEMENT_PAISE * 6 }), MoneyError);
});

test("commissionPct is read from the environment and clamped", () => {
  const prev = process.env.RESQ_COMMISSION_PCT;
  try {
    delete process.env.RESQ_COMMISSION_PCT;
    assert.equal(commissionPct(), DEFAULT_COMMISSION_PCT);
    process.env.RESQ_COMMISSION_PCT = "15";
    assert.equal(commissionPct(), 15);
    process.env.RESQ_COMMISSION_PCT = "90";
    assert.equal(commissionPct(), MAX_COMMISSION_PCT, "a fat-fingered percentage cannot eat a worker's earnings");
    process.env.RESQ_COMMISSION_PCT = "-5";
    assert.equal(commissionPct(), 0);
    process.env.RESQ_COMMISSION_PCT = "banana";
    assert.equal(commissionPct(), DEFAULT_COMMISSION_PCT);
  } finally {
    if (prev === undefined) delete process.env.RESQ_COMMISSION_PCT; else process.env.RESQ_COMMISSION_PCT = prev;
  }
});

test("rupees are formatted the way an Indian invoice reads", () => {
  assert.equal(formatPaise(0), "₹0");
  assert.equal(formatPaise(80_00), "₹80");
  assert.equal(formatPaise(1_050_00), "₹1,050");
  assert.equal(formatPaise(1_23_456_78), "₹1,23,456.78");
  assert.equal(formatPaise(-250_00), "-₹250");
});

test("what a human types becomes paise, and junk becomes null", () => {
  assert.equal(parseRupeesToPaise("450"), 450_00);
  assert.equal(parseRupeesToPaise("450.50"), 450_50);
  assert.equal(parseRupeesToPaise("₹1,200"), 1_200_00);
  assert.equal(parseRupeesToPaise(450), 450_00);
  for (const junk of ["", "abc", "45.678", "-10", "1e5", null, undefined, {}]) {
    assert.equal(parseRupeesToPaise(junk), null, `${String(junk)} should not parse`);
  }
});
