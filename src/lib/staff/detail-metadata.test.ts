import { describe, expect, it, vi } from "vitest";
import { detailMetadata } from "./detail-metadata";

describe("detail metadata", () => {
  it.each([
    ["Bill", "Hi Precision", "Bill · Hi Precision"],
    ["Vendor", "  ACME & Sons  ", "Vendor · ACME & Sons"],
    ["Payment", "REF-123", "Payment · REF-123"],
    ["Journal Entry", "JE-2026-001", "Journal Entry · JE-2026-001"],
  ])("identifies %s by its subject without adding a site suffix", async (name, subject, title) => {
    expect(await detailMetadata(name, async () => subject)).toEqual({ title });
  });
  it.each([null, undefined, "", "   "])("falls back for a missing/blank subject: %s", async (subject) => {
    expect(await detailMetadata("Bill", async () => subject)).toEqual({ title: "Bill" });
  });
  it("falls back for a rejected lookup without leaking its error", async () => {
    expect(await detailMetadata("Payment", async () => { throw new Error("database unavailable"); })).toEqual({ title: "Payment" });
  });
});

// Exercise the real payslip metadata entry point: adding a title must not bypass
// ownership/run visibility, or perform the page's disclosure audit / PDF load.
const payslipFixture = vi.hoisted(() => ({
  session: { user_id: "staff-a", role: "medtech" },
  row: null as unknown,
  error: null as { message: string } | null,
  audit: vi.fn(),
  loadPdf: vi.fn(),
}));
vi.mock("@/lib/auth/require-staff", () => ({ requireActiveStaff: async () => payslipFixture.session }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: () => ({ select: () => ({ eq: () => ({
  maybeSingle: async () => ({ data: payslipFixture.row, error: payslipFixture.error }),
}) }) }) }) }));
vi.mock("@/lib/payroll/payslip-pdf", () => ({ loadPayslipData: payslipFixture.loadPdf }));
vi.mock("@/lib/audit/log", () => ({ audit: payslipFixture.audit }));
vi.mock("@/lib/observability/report-error", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/server/action-helpers", () => ({ hasRecentAudit: vi.fn() }));
vi.mock("@/app/(staff)/staff/payslips/[id]/payslip-detail-client", () => ({ PayslipDetailClient: () => null }));
import { generateMetadata as payslipMetadata } from "@/app/(staff)/staff/payslips/[id]/page";

describe("payslip metadata authorization", () => {
  it.each([
    ["medtech", "staff-a", "finalised", true],
    ["medtech", "staff-a", "computed", false],
    ["medtech", "staff-a", "draft", false],
    ["medtech", "staff-b", "finalised", false],
    ["admin", "staff-b", "draft", true],
  ])("%s viewing %s's %s run exposes a period only when allowed", async (role, owner, status, allowed) => {
    payslipFixture.session = { user_id: "staff-a", role };
    payslipFixture.error = null;
    payslipFixture.row = {
      employees: { staff_profile_id: owner },
      payroll_runs: { status, payroll_periods: { period_start: "2026-09-01", period_end: "2026-09-15" } },
    };
    expect(await payslipMetadata({ params: Promise.resolve({ id: "run-row" }) })).toEqual({
      title: allowed ? "Payslip · Sep 1, 2026 – Sep 15, 2026" : "Payslip",
    });
    expect(payslipFixture.audit).not.toHaveBeenCalled();
    expect(payslipFixture.loadPdf).not.toHaveBeenCalled();
  });
  it.each([null, { message: "private database error" }])("falls back on absent/failed lookups without error text", async (error) => {
    payslipFixture.row = null;
    payslipFixture.error = error;
    expect(await payslipMetadata({ params: Promise.resolve({ id: "missing" }) })).toEqual({ title: "Payslip" });
  });
});
