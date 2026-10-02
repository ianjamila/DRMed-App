import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 0224: createPfDisbursement and createBulkPfPayoutCash pay a doctor through ONE SQL
 * function (pf_disburse_entries) instead of read / validate / insert header / link as four
 * separate statements. These tests pin what the actions still own (arguments, audit rows,
 * the refusal wording, the bulk rollback) and that neither action writes the payout tables
 * itself any more. The function's own behaviour is proven against a real database by
 * scripts/gl-bridge-concurrency-proof.ts (K1a-K1d, PD1-PD5).
 */

const fx = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcResults: [] as Array<{ data: unknown; error: { code?: string; message: string } | null }>,
  tableTouches: [] as string[],
  audits: [] as Array<Record<string, unknown>>,
  voided: [] as Array<Record<string, unknown>>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/require-admin", () => ({
  requireAdminStaff: async () => ({ user_id: "staff-1", role: "admin" }),
}));
vi.mock("@/lib/audit/log", () => ({
  audit: async (row: Record<string, unknown>) => {
    fx.audits.push(row);
  },
}));
vi.mock("@/lib/accounting/pf-disbursement-void", () => ({
  voidPfDisbursementAndUnlink: async (_admin: unknown, input: Record<string, unknown>) => {
    fx.voided.push(input);
    return { ok: true };
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      fx.rpcCalls.push({ fn, args });
      return fx.rpcResults.shift() ?? { data: null, error: { message: "no scripted result" } };
    },
    from: (table: string) => {
      fx.tableTouches.push(table);
      throw new Error(`the payout actions must not touch ${table} directly (0224)`);
    },
  }),
}));

import { createPfDisbursement } from "./pf-disbursements";
import { createBulkPfPayoutCash } from "./pf-bulk-payout";

const PHYS = "11111111-1111-4111-8111-111111111111";
const PHYS2 = "22222222-2222-4222-8222-222222222222";
const E1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const E2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const E3 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const D1 = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const D2 = "dddddddd-dddd-4ddd-8ddd-ddddddddddd2";

const ok = (id: string, n: number) => ({ data: { disbursement_id: id, batch_number: n }, error: null });
const refuse = (message: string) => ({ data: null, error: { code: "P0085", message } });

beforeEach(() => {
  fx.rpcCalls = [];
  fx.rpcResults = [];
  fx.tableTouches = [];
  fx.audits = [];
  fx.voided = [];
});

describe("createPfDisbursement — one RPC", () => {
  const input = {
    physician_id: PHYS,
    posted_date: "2026-10-02",
    method: "gcash" as const,
    total_php: 600,
    entry_ids: [E1, E2],
    notes: "October first half",
  };

  it("sends the whole payout to pf_disburse_entries, audits it and returns the ids", async () => {
    fx.rpcResults.push(ok(D1, 7));
    const res = await createPfDisbursement(input);
    expect(res).toEqual({ ok: true, data: { disbursement_id: D1, batch_number: 7 } });
    expect(fx.rpcCalls).toEqual([
      {
        fn: "pf_disburse_entries",
        args: {
          p_physician_id: PHYS,
          p_entry_ids: [E1, E2],
          p_posted_date: "2026-10-02",
          p_method: "gcash",
          p_total_php: 600,
          p_recorded_by: "staff-1",
          p_notes: "October first half",
        },
      },
    ]);
    expect(fx.tableTouches).toEqual([]);
    expect(fx.audits).toEqual([
      {
        actor_id: "staff-1",
        actor_type: "staff",
        action: "pf_disbursement.created",
        resource_type: "doctor_pf_disbursements",
        resource_id: D1,
        metadata: { physician_id: PHYS, method: "gcash", total_php: 600, entry_count: 2, batch_number: 7 },
      },
    ]);
  });

  it("leaves p_notes out when there are none (the SQL default is null)", async () => {
    fx.rpcResults.push(ok(D1, 8));
    await createPfDisbursement({ ...input, notes: undefined });
    expect(fx.rpcCalls[0]!.args.p_notes).toBeUndefined();
  });

  it.each([
    "One or more PF entries not found",
    "PF entries must all belong to the same physician",
    "One or more PF entries are not open for disbursement",
    "Total mismatch: expected 600, got 500",
  ])("shows the refusal %j as written and audits nothing", async (message) => {
    fx.rpcResults.push(refuse(message));
    expect(await createPfDisbursement(input)).toEqual({ ok: false, error: message });
    expect(fx.audits).toEqual([]);
  });

  it("an RPC result it cannot read is never audited as a payout, and points at Already paid", async () => {
    fx.rpcResults.push({ data: { batch_number: 3 }, error: null });
    const res = await createPfDisbursement(input);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/Already paid/);
    expect(fx.audits).toEqual([]);
  });

  it("rejects a malformed request before the database is called", async () => {
    const res = await createPfDisbursement({ ...input, entry_ids: [] });
    expect(res.ok).toBe(false);
    expect(fx.rpcCalls).toEqual([]);
  });
});

describe("createBulkPfPayoutCash — one RPC per doctor, earlier payouts voided on a later failure", () => {
  const input = {
    posted_date: "2026-10-02",
    by_physician: [
      { physician_id: PHYS, entry_ids: [E1, E2], total_php: 600 },
      { physician_id: PHYS2, entry_ids: [E3], total_php: 150 },
    ],
  };

  it("pays each doctor in cash with the bulk note and audits the batch once", async () => {
    fx.rpcResults.push(ok(D1, 1), ok(D2, 2));
    const res = await createBulkPfPayoutCash(input);
    expect(res).toEqual({ ok: true, data: { disbursement_ids: [D1, D2] } });
    expect(fx.rpcCalls.map((c) => [c.fn, c.args.p_physician_id, c.args.p_entry_ids, c.args.p_total_php])).toEqual([
      ["pf_disburse_entries", PHYS, [E1, E2], 600],
      ["pf_disburse_entries", PHYS2, [E3], 150],
    ]);
    for (const c of fx.rpcCalls) {
      expect(c.args).toMatchObject({
        p_method: "cash",
        p_posted_date: "2026-10-02",
        p_recorded_by: "staff-1",
        p_notes: "Bulk EOD payout 2026-10-02",
      });
    }
    expect(fx.tableTouches).toEqual([]);
    expect(fx.voided).toEqual([]);
    expect(fx.audits).toHaveLength(1);
    expect(fx.audits[0]).toMatchObject({ action: "pf_disbursement.created", metadata: { bulk: true, count: 2, posted_date: "2026-10-02" } });
  });

  it("a refusal on the second doctor voids the first through the shared void path and says so", async () => {
    fx.rpcResults.push(ok(D1, 1), refuse("One or more PF entries are not open for disbursement"));
    const res = await createBulkPfPayoutCash(input);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/^One or more PF entries are not open for disbursement/);
    expect(!res.ok && res.error).toMatch(/1 of 2 payouts in this batch were already created and have been rolled back/);
    expect(fx.voided).toEqual([
      expect.objectContaining({
        disbursementId: D1,
        voidedBy: "staff-1",
        voidReason: "bulk_failed",
        auditContext: expect.objectContaining({ bulk_rollback: true }),
      }),
    ]);
    expect(fx.audits).toEqual([]);
  });

  it("a refusal on the first doctor needs no rollback and no partial-failure suffix", async () => {
    fx.rpcResults.push(refuse("Total mismatch: expected 600, got 500"));
    expect(await createBulkPfPayoutCash(input)).toEqual({ ok: false, error: "Total mismatch: expected 600, got 500" });
    expect(fx.voided).toEqual([]);
    expect(fx.rpcCalls).toHaveLength(1);
  });

  it("an unreadable confirmation stops the batch and rolls back what was created", async () => {
    fx.rpcResults.push(ok(D1, 1), { data: null, error: null });
    const res = await createBulkPfPayoutCash(input);
    expect(res.ok).toBe(false);
    expect(fx.voided.map((v) => v.disbursementId)).toEqual([D1]);
    expect(fx.audits).toEqual([]);
  });
});

describe("neither payout action writes the payout tables itself", () => {
  for (const file of ["pf-disbursements.ts", "pf-bulk-payout.ts"]) {
    it(`${file} has no direct doctor_pf_* read or write`, () => {
      const src = readFileSync(join(process.cwd(), "src/lib/actions/accounting", file), "utf8");
      expect(src).not.toMatch(/\.from\("doctor_pf_(entries|disbursements)"\)/);
      expect(src).not.toMatch(/next_pf_disbursement_batch_number/);
      expect(src).toMatch(/rpc\("pf_disburse_entries"/);
    });
  }
});
