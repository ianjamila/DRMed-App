import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Shift-handling coverage for `postTillCashExpense` (the shared Clinic Cash
 * writer behind Petty Cash, Cash Drawer payouts, and admin Quick expense).
 *
 * With more than one active `cash_shifts` row, a caller-picked shift must be
 * re-verified here rather than trusted — see the doc comment on the
 * `shift_id` arg. These tests pin that: a valid active shift is used as-is,
 * an inactive or unknown shift is refused with a plain message, and omitting
 * the arg keeps the pre-existing first-active-shift fallback every other
 * caller (Cash Drawer's own payout path is a different writer;
 * `voidTillCashExpense` and Quick expense both still call this function with
 * no `shift_id`) relies on.
 *
 * The admin client is faked table-by-table, mirroring the shape used in
 * `src/lib/staff/detail-metadata.test.ts` — `npm test` has no database, and a
 * real Supabase query builder is not worth standing up for four fixed calls.
 */

const fx = vi.hoisted(() => ({
  shiftsById: new Map<string, { id: string; is_active: boolean }>([
    ["shift-morning", { id: "shift-morning", is_active: true }],
    ["shift-night", { id: "shift-night", is_active: true }],
    ["shift-retired", { id: "shift-retired", is_active: false }],
  ]),
  firstActiveShift: { id: "shift-morning" } as { id: string } | null,
  cashShiftsError: null as { message: string } | null,
  coaId: "coa-office-supplies",
  coaError: null as { message: string } | null,
  insertError: null as { message: string } | null,
  insertedRow: { id: "adjustment-1" } as { id: string },
  insertedPayload: null as Record<string, unknown> | null,
  jeRow: { id: "je-1", entry_number: "JE-0001" } as { id: string; entry_number: string } | null,
}));

function cashShiftsTable() {
  const calls: { method: string; args: unknown[] }[] = [];
  const q = {
    select: (...args: unknown[]) => { calls.push({ method: "select", args }); return q; },
    eq: (...args: unknown[]) => { calls.push({ method: "eq", args }); return q; },
    order: (...args: unknown[]) => { calls.push({ method: "order", args }); return q; },
    limit: (...args: unknown[]) => { calls.push({ method: "limit", args }); return q; },
    maybeSingle: async () => {
      if (fx.cashShiftsError) return { data: null, error: fx.cashShiftsError };
      const idFilter = calls.find((c) => c.method === "eq" && c.args[0] === "id");
      if (idFilter) {
        const id = idFilter.args[1] as string;
        return { data: fx.shiftsById.get(id) ?? null, error: null };
      }
      // Fallback path: `.eq("is_active", true).order().order().limit(1)`.
      return { data: fx.firstActiveShift, error: null };
    },
  };
  return q;
}

function chartOfAccountsTable() {
  const q = {
    select: () => q,
    eq: () => q,
    maybeSingle: async () =>
      fx.coaError
        ? { data: null, error: fx.coaError }
        : { data: { id: fx.coaId }, error: null },
  };
  return q;
}

function eodCashAdjustmentsTable() {
  const q = {
    insert: (payload: Record<string, unknown>) => { fx.insertedPayload = payload; return q; },
    select: () => q,
    single: async () =>
      fx.insertError
        ? { data: null, error: fx.insertError }
        : { data: fx.insertedRow, error: null },
  };
  return q;
}

function journalEntriesTable() {
  const q = {
    select: () => q,
    eq: () => q,
    maybeSingle: async () => ({ data: fx.jeRow, error: null }),
  };
  return q;
}

// `postTillCashExpense` guards itself with `import "server-only"`, which
// throws outside a Server Component/Action module graph (Next.js's own
// safeguard against a service-role-touching function reaching the browser
// bundle). That guard is irrelevant to a Node test process with a fully
// mocked admin client below, so it is neutralised the same way Next.js's own
// testing docs recommend for a server-only utility.
vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      switch (table) {
        case "cash_shifts":
          return cashShiftsTable();
        case "chart_of_accounts":
          return chartOfAccountsTable();
        case "eod_cash_adjustments":
          return eodCashAdjustmentsTable();
        case "journal_entries":
          return journalEntriesTable();
        default:
          throw new Error(`unexpected table in test: ${table}`);
      }
    },
  }),
}));

import { postTillCashExpense } from "./post-till-cash-expense";

function baseArgs(overrides: Partial<Parameters<typeof postTillCashExpense>[0]> = {}) {
  return {
    business_date: "2024-01-01",
    category: "Office Supplies" as const,
    amount_php: 150,
    vendor_label: "Wilcon Depot",
    description: null,
    actorId: "staff-1",
    ...overrides,
  };
}

describe("postTillCashExpense — shift handling", () => {
  beforeEach(() => {
    fx.firstActiveShift = { id: "shift-morning" };
    fx.cashShiftsError = null;
    fx.coaError = null;
    fx.insertError = null;
    fx.insertedPayload = null;
    fx.insertedRow = { id: "adjustment-1" };
    fx.jeRow = { id: "je-1", entry_number: "JE-0001" };
  });

  it("books to the caller's shift when it is a valid active shift", async () => {
    const result = await postTillCashExpense(baseArgs({ shift_id: "shift-night" }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.shift_id).toBe("shift-night");
    expect(fx.insertedPayload?.shift_id).toBe("shift-night");
  });

  it("refuses a shift that exists but is inactive", async () => {
    const result = await postTillCashExpense(baseArgs({ shift_id: "shift-retired" }));
    expect(result).toEqual({
      ok: false,
      error: "That cash shift is not active. Pick another shift.",
    });
    expect(fx.insertedPayload).toBeNull();
  });

  it("refuses a shift id that does not exist", async () => {
    const result = await postTillCashExpense(baseArgs({ shift_id: "shift-nonexistent" }));
    expect(result).toEqual({
      ok: false,
      error: "That cash shift is not active. Pick another shift.",
    });
    expect(fx.insertedPayload).toBeNull();
  });

  it("falls back to the first active shift when shift_id is omitted", async () => {
    const result = await postTillCashExpense(baseArgs());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.shift_id).toBe("shift-morning");
    expect(fx.insertedPayload?.shift_id).toBe("shift-morning");
  });

  it("errors when no active shift is configured and none was picked", async () => {
    fx.firstActiveShift = null;
    const result = await postTillCashExpense(baseArgs());
    expect(result).toEqual({
      ok: false,
      error: "No active cash shift is configured. Ask an admin to set one up.",
    });
  });
});
