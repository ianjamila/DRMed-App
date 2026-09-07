import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MONEY_SETTLED_VISITS_OR,
  moneySettled,
  SETTLED_PAYMENT_STATUSES,
  type MoneySettledVisit,
} from "./money-settled";

function visit(overrides: Partial<MoneySettledVisit> = {}): MoneySettledVisit {
  return { payment_status: "unpaid", hmo_provider_id: null, ...overrides };
}

const HMO_ID = "3a5c8d0e-0000-0000-0000-000000000001";

describe("moneySettled", () => {
  it("settles a fully paid cash visit", () => {
    expect(moneySettled(visit({ payment_status: "paid" }))).toBe(true);
  });

  it("settles a waived visit", () => {
    expect(moneySettled(visit({ payment_status: "waived" }))).toBe(true);
  });

  it("settles an HMO visit at any payment status — the receivable is booked at release", () => {
    for (const payment_status of ["unpaid", "partial", "paid", "waived"]) {
      expect(moneySettled(visit({ payment_status, hmo_provider_id: HMO_ID }))).toBe(
        true,
      );
    }
  });

  it("does not settle an unpaid cash visit", () => {
    expect(moneySettled(visit())).toBe(false);
  });

  it("does not settle a partially paid cash visit — the gate is paid-in-full", () => {
    expect(moneySettled(visit({ payment_status: "partial" }))).toBe(false);
  });

  it("lists exactly the two self-settling payment statuses", () => {
    expect(SETTLED_PAYMENT_STATUSES).toEqual(["paid", "waived"]);
  });
});

describe("MONEY_SETTLED_VISITS_OR", () => {
  // The PostgREST filter string must encode exactly the predicate
  // moneySettled() implements — they ship as a pair.
  it("names both passing payment statuses and the HMO carve-out", () => {
    expect(MONEY_SETTLED_VISITS_OR).toBe(
      "payment_status.in.(paid,waived),hmo_provider_id.not.is.null",
    );
  });
});

describe("migration 0133 — the DB release gate encodes the same rule", () => {
  // The trigger is the source of truth for money; this predicate is only the
  // UX mirror of it. If someone edits one without the other, staff get buttons
  // that throw. There is no pgTAP runner in `npm test`, so pin the SQL text.
  const sql = readFileSync(
    join(process.cwd(), "supabase/migrations/0133_hmo_release_gate.sql"),
    "utf8",
  );

  it("replaces the release trigger function", () => {
    expect(sql).toMatch(
      /create or replace function public\.enforce_payment_before_release\(\)/,
    );
  });

  it("passes paid, waived, or any visit with an HMO provider", () => {
    expect(sql).toMatch(
      /v_payment_status not in \('paid', 'waived'\)\s+and v_hmo_provider_id is null/,
    );
  });

  it("keeps the substring pg-errors.ts and finalise-consolidated.ts match on", () => {
    // Both read the raised message with /payment_status/i to tell the payment
    // gate apart from the consent gate on SQLSTATE 23514.
    const raise = sql.slice(sql.indexOf("raise exception"));
    expect(raise).toMatch(/payment_status/);
    expect(raise).toMatch(/errcode = 'check_violation'/);
  });

  it("restates the function ACL 0118 never swept", () => {
    expect(sql).toMatch(
      /revoke execute on function public\.enforce_payment_before_release\(\) from public, anon, authenticated;/,
    );
  });

  it("keeps search_path pinned on the replaced function", () => {
    expect(sql).toMatch(/set search_path = public/);
  });
});
