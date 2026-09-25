import { describe, expect, it } from "vitest";
import { checkCompleteQuery } from "./paged-query-test-helpers";

const root = "src/app/(staff)/staff/(dashboard)/";
const cases: {
  name: string; file: string; index: number; table: string;
  bindings?: Record<string, unknown>; filters: Record<string, string>;
}[] = [
  { name: "cash drawer day and shift", file: "payments/cash-drawer/page.tsx", index: 0,
    table: "eod_cash_adjustments", bindings: { business_date: "2026-09-16", shift_id: "shift" },
    filters: { business_date: "eq.2026-09-16", shift_id: "eq.shift" } },
  { name: "cash drawer action", file: "payments/cash-drawer/actions.ts", index: 0,
    table: "eod_cash_adjustments", bindings: { business_date: "2026-09-16", shift_id: "shift" },
    filters: { business_date: "eq.2026-09-16", shift_id: "eq.shift" } },
  { name: "petty cash for one shift", file: "payments/petty-cash/page.tsx", index: 0,
    table: "eod_cash_adjustments", bindings: { business_date: "2026-09-16", shift_id: "shift" },
    filters: { business_date: "eq.2026-09-16", kind: "eq.petty_cash", shift_id: "eq.shift" } },
  { name: "all trueups", file: "admin/accounting/cogs/send-outs/page.tsx", index: 1,
    table: "cogs_send_out_trueups", filters: {} },
  { name: "annual nonvoid trueups", file: "admin/accounting/cogs/send-outs/vendor-performance/page.tsx", index: 1,
    table: "cogs_send_out_trueups", filters: { voided_at: "is.null" } },
  { name: "active inventory sections", file: "admin/inventory/page.tsx", index: 0,
    table: "v_inventory_balances", filters: { is_active: "eq.true", order: "item_id.asc" } },
  { name: "annual nonvoid PF payouts", file: "admin/accounting/pf-ytd-summary/page.tsx", index: 1,
    table: "doctor_pf_disbursements", filters: { voided_at: "is.null" } },
  { name: "gift sales", file: "admin/gift-codes/sales/page.tsx", index: 0,
    table: "gift_codes", filters: {} },
  { name: "provider batch history", file: "admin/accounting/hmo-claims/[providerId]/page.tsx", index: 0,
    table: "hmo_claim_batches", filters: { provider_id: "eq.provider" } },
  { name: "snapshot date discovery", file: "admin/accounting/hmo-claims/aging-snapshots/page.tsx", index: 0,
    table: "hmo_aging_snapshots", filters: { order: "snapshot_date.desc,id.asc" } },
  { name: "selected snapshot", file: "admin/accounting/hmo-claims/aging-snapshots/page.tsx", index: 1,
    table: "hmo_aging_snapshots", bindings: { selectedDate: "2026-09-16" }, filters: { snapshot_date: "eq.2026-09-16" } },
  { name: "bank statement detail", file: "admin/accounting/bank-rec/[id]/page.tsx", index: 0,
    table: "bank_statement_lines", bindings: { id: "statement" }, filters: { statement_id: "eq.statement" } },
  { name: "bank detail global exclusions", file: "admin/accounting/bank-rec/[id]/page.tsx", index: 1,
    table: "bank_statement_lines", filters: { matched_je_line_id: "not.is.null" } },
  { name: "bank auto-match input", file: "admin/accounting/bank-rec/actions.ts", index: 0,
    table: "bank_statement_lines", bindings: { statementId: "statement" },
    filters: { statement_id: "eq.statement", matched_je_line_id: "is.null" } },
  { name: "bank auto-match global exclusions", file: "admin/accounting/bank-rec/actions.ts", index: 1,
    table: "bank_statement_lines", filters: { matched_je_line_id: "not.is.null" } },
];

describe.each(cases)("dormant query: $name", ({ name, file, index, table, bindings, filters }) => {
  it("returns all 1,505 rows, with stable pages and unchanged predicates", async () => {
    const requests = await checkCompleteQuery(root + file, index, bindings);
    for (const url of requests) {
      expect(url.pathname).toBe(`/rest/v1/${table}`);
      for (const [key, value] of Object.entries(filters)) expect(url.searchParams.get(key)).toBe(value);
      if (file.includes("vendor-performance")) expect(url.searchParams.getAll("matched_at")).toEqual([
        "gte.2025-12-31T16:00:00Z", "lt.2026-12-31T16:00:00Z",
      ]);
      if (table === "doctor_pf_disbursements") expect(url.searchParams.getAll("posted_date")).toEqual([
        "gte.2026-01-01", "lte.2026-12-31",
      ]);
      if (table === "gift_codes") expect(url.searchParams.getAll("purchased_at")).toEqual([
        "gte.2025-12-31T16:00:00Z", "lt.2026-12-31T16:00:00Z", "not.is.null",
      ]);
      if (name.includes("global")) expect(url.searchParams.has("statement_id")).toBe(false);
    }
  });
  it("discards earlier rows when a later page fails", async () => {
    await checkCompleteQuery(root + file, index, bindings, { failAtOffset: 1000 });
  });
});

describe.each([false, true])("unacknowledged alerts, ownScopeOnly=%s", (ownScopeOnly) => {
  const bindings = {
    alertSelect: "id, test_requests!inner ( assigned_to )",
    scopeToOwn: <T extends { eq(column: string, value: string): T }>(q: T) =>
      ownScopeOnly ? q.eq("test_requests.assigned_to", "staff") : q,
  };
  it("keeps the complete visible worklist and assignment restriction", async () => {
    const requests = await checkCompleteQuery(root + "critical-alerts/page.tsx", 0, bindings);
    for (const url of requests) {
      expect(url.searchParams.get("acknowledged_at")).toBe("is.null");
      expect(url.searchParams.get("test_requests.assigned_to")).toBe(ownScopeOnly ? "eq.staff" : null);
      expect(url.searchParams.get("order")).toBe("created_at.desc,id.asc");
    }
  });
  it("never returns a partial worklist after an error", async () => {
    await checkCompleteQuery(root + "critical-alerts/page.tsx", 0, bindings, { failAtOffset: 1000 });
  });
});
