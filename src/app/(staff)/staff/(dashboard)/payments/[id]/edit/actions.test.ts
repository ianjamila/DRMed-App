import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Wiring coverage for `editPaymentAction`'s released-and-owing alert: the
 * pure condition lives in `released-payment-alert-content.ts` and is tested
 * there; this pins that the ACTION re-reads the visit after a money change,
 * records what it found on the `payment.edited` audit row, and dispatches the
 * alert through `after()` with no free text — so removing the dispatch, or the
 * re-read, fails here and not only in a browser.
 *
 * The admin client is faked table-by-table, the shape used in
 * `src/lib/actions/accounting/post-till-cash-expense.test.ts`.
 */

vi.mock("server-only", () => ({}));

const fx = vi.hoisted(() => ({
  before: {
    id: "pay-1",
    visit_id: "visit-1",
    amount_php: "1000.00",
    method: "cash",
    reference_number: null as string | null,
    notes: null as string | null,
    voided_at: null as string | null,
    legacy_import_run_id: null as string | null,
    visits: { patient_id: "patient-1" },
  },
  visitAfter: { payment_status: "partial", hmo_provider_id: null as string | null },
  completed: new Map<string, { results: number; consults: number; procedures: number }>([
    ["visit-1", { results: 1, consults: 1, procedures: 0 }],
  ]),
  completedReads: 0,
  audits: [] as Record<string, unknown>[],
  deferred: [] as (() => unknown)[],
  alerts: [] as Record<string, unknown>[],
  visitReads: 0,
}));

vi.mock("next/headers", () => ({ headers: async () => ({ get: () => null }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/server", () => ({
  after: (fn: () => unknown) => {
    fx.deferred.push(fn);
  },
}));
vi.mock("@/lib/auth/require-staff", () => ({
  requireActiveStaff: async () => ({ user_id: "staff-1", role: "admin" }),
}));
// 0167: the patient-active gate is its own guard with its own tests; here
// the record is always live.
vi.mock("@/lib/patients/require-active", () => ({
  assertVisitPatientActive: async () => ({ ok: true }),
}));
vi.mock("@/lib/audit/log", () => ({
  audit: async (entry: Record<string, unknown>) => {
    fx.audits.push(entry);
  },
}));
vi.mock("@/lib/visits/released-results", () => ({
  loadCompletedWorkCounts: async () => {
    fx.completedReads += 1;
    return fx.completed;
  },
}));
vi.mock("@/lib/visits/released-payment-alert", () => ({
  sendReleasedPaymentRemovedAlert: async (input: Record<string, unknown>) => {
    fx.alerts.push(input);
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async () => ({ data: "pay-2", error: null }),
    from: (table: string) => {
      if (table === "payments") {
        const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: fx.before, error: null }) };
        return q;
      }
      if (table === "visits") {
        const q = {
          select: () => q,
          eq: () => q,
          is: () => q,
          maybeSingle: async () => {
            fx.visitReads += 1;
            return { data: fx.visitAfter, error: null };
          },
        };
        return q;
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

import { editPaymentAction } from "./actions";

const FREE_TEXT = "keyed the wrong amount for Juan dela Cruz, CBC";

function edit(overrides: Partial<{ amount: string; method: string; referenceNumber: string; notes: string }> = {}) {
  return editPaymentAction({
    paymentId: "3f6c2b1e-4d5a-4b7c-9e8f-0a1b2c3d4e5f",
    amount: "800",
    method: "cash",
    referenceNumber: "",
    notes: "",
    reason: FREE_TEXT,
    expected: { amount_php: 1000, method: "cash", reference_number: null, notes: null },
    ...overrides,
  });
}

beforeEach(() => {
  fx.audits.length = 0;
  fx.deferred.length = 0;
  fx.alerts.length = 0;
  fx.completedReads = 0;
  fx.visitReads = 0;
  fx.visitAfter = { payment_status: "partial", hmo_provider_id: null };
});

describe("editPaymentAction — released-and-owing alert wiring", () => {
  it("amount down on a visit with completed work: audits the re-read and queues the alert via after()", async () => {
    expect(await edit()).toEqual({ ok: true });
    const meta = fx.audits[0]!.metadata as Record<string, unknown>;
    expect(fx.audits[0]!.action).toBe("payment.edited");
    expect(meta).toMatchObject({ money_changed: true, settled_after: false, released_count: 1, completed_work: 2 });

    // Nothing is sent inline; the dispatch is deferred.
    expect(fx.alerts).toEqual([]);
    expect(fx.deferred).toHaveLength(1);
    for (const fn of fx.deferred) await fn();
    expect(fx.alerts).toHaveLength(1);
    expect(fx.alerts[0]).toMatchObject({
      change: "edited",
      paymentId: "3f6c2b1e-4d5a-4b7c-9e8f-0a1b2c3d4e5f",
      visitId: "visit-1",
      amountPhp: 1000,
      methodLabel: "Cash",
      reasonLabel: null,
      movedToVisitNumber: null,
      editedTo: { amountPhp: 800, methodLabel: "Cash" },
      completed: { results: 1, consults: 1, procedures: 0 },
    });
  });

  it("never hands the typed reason (free text) to the alert", async () => {
    await edit();
    for (const fn of fx.deferred) await fn();
    expect(JSON.stringify(fx.alerts[0])).not.toContain(FREE_TEXT);
    expect(fx.alerts[0]).not.toHaveProperty("reason");
    // The audit row does keep it — that is its job.
    expect((fx.audits[0]!.metadata as Record<string, unknown>).reason).toBe(FREE_TEXT);
  });

  it("a consult-only visit alerts too (completed work, not results)", async () => {
    fx.completed.set("visit-1", { results: 0, consults: 1, procedures: 0 });
    try {
      await edit();
      expect((fx.audits[0]!.metadata as Record<string, unknown>).completed_work).toBe(1);
      expect(fx.deferred).toHaveLength(1);
    } finally {
      fx.completed.set("visit-1", { results: 1, consults: 1, procedures: 0 });
    }
  });

  it("method-only change: re-reads and audits, but removes no money so no alert", async () => {
    await edit({ amount: "1000", method: "gcash" });
    const meta = fx.audits[0]!.metadata as Record<string, unknown>;
    expect(meta).toMatchObject({ money_changed: true, settled_after: false, completed_work: 2 });
    expect(fx.deferred).toEqual([]);
  });

  it("amount up: no alert", async () => {
    await edit({ amount: "1500" });
    expect(fx.deferred).toEqual([]);
  });

  it("still settled after the edit: no alert", async () => {
    fx.visitAfter = { payment_status: "paid", hmo_provider_id: null };
    await edit();
    expect((fx.audits[0]!.metadata as Record<string, unknown>).settled_after).toBe(true);
    expect(fx.deferred).toEqual([]);
  });

  it("reference/notes-only edit: skips the re-read, audits nulls, no alert", async () => {
    await edit({ amount: "1000", referenceNumber: "OR-77" });
    expect(fx.visitReads).toBe(0);
    expect(fx.completedReads).toBe(0);
    const meta = fx.audits[0]!.metadata as Record<string, unknown>;
    expect(meta).toMatchObject({ money_changed: false, settled_after: null, released_count: null, completed_work: null });
    expect(fx.deferred).toEqual([]);
  });
});
