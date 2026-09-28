// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  params: new URLSearchParams(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => nav.router,
  useSearchParams: () => nav.params,
}));

import { BillsIndexClient } from "../bills/bills-index-client";
import { PaymentsIndexClient } from "../payments/payments-index-client";

// Every AP bill and payment on prod in 2026-09 was a voided duplicate from the
// June books reconciliation, so both lists opened on nothing but greyed-out
// rows. They now hide voided rows unless ?voided=1, and always say how many
// they are hiding.

const bill = (id: string, status: string) => ({
  id,
  bill_number: `BL-${id}`,
  vendor_id: "v1",
  vendor_name: "Vendor",
  vendor_invoice_number: null,
  bill_date: "2026-05-01",
  due_date: "2026-05-31",
  status,
  gross_amount: 100,
  wt_amount: 0,
  net_payable: 100,
  paid_amount: 0,
  outstanding_amount: status === "voided" ? 0 : 100,
  description: null,
  created_at: "2026-05-01T00:00:00Z",
});

const payment = (id: string, voided: boolean) => ({
  id,
  vendor_id: "v1",
  vendor_name: "Vendor",
  payment_number: `BP-${id}`,
  payment_date: "2026-05-01",
  method: "cash",
  amount_php: 100,
  cash_account_id: "c1",
  reference: null,
  cheque_number: null,
  cheque_date: null,
  void_reason: voided ? "duplicate" : null,
  voided_at: voided ? "2026-06-07T00:00:00Z" : null,
  created_at: "2026-05-01T00:00:00Z",
});

const billFilter = { vendor_id: "", status: "", has_wt: false, q: "" };
const payFilter = { vendor_id: "", method: "", q: "" };

function setParams(qs: string) {
  nav.params = new URLSearchParams(qs);
}

beforeEach(() => {
  nav.router.push.mockReset();
  setParams("");
});
afterEach(cleanup);

// Row links only — the sortable column headers are links too.
const rowLinks = () => within(screen.getAllByRole("rowgroup")[1]).queryAllByRole("link").map((a) => a.textContent);

describe("AP Bills list — voided bills", () => {
  const bills = [bill("1", "posted"), bill("2", "voided"), bill("3", "paid"), bill("4", "voided")];

  it("hides voided bills by default and says how many", () => {
    render(<BillsIndexClient initialBills={bills} vendors={[]} initialFilter={billFilter} />);
    expect(rowLinks().sort()).toEqual(["BL-1", "BL-3"]);
    expect((screen.getByRole("checkbox", { name: "Show voided (2)" }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText("2 voided bills hidden.")).toBeTruthy();
  });

  it("ticking Show voided navigates to ?voided=1 and keeps the other filters, back on page 1", async () => {
    setParams("vendor_id=v1&sort=status&dir=asc&page=2");
    render(<BillsIndexClient initialBills={bills} vendors={[]} initialFilter={billFilter} />);
    await userEvent.setup().click(screen.getByRole("checkbox", { name: "Show voided (2)" }));
    expect(nav.router.push).toHaveBeenCalledWith(
      "/staff/admin/accounting/ap/bills?vendor_id=v1&voided=1&sort=status&dir=asc",
      { scroll: false },
    );
  });

  it("shows voided bills with ?voided=1 and unticking drops the param", async () => {
    setParams("voided=1");
    render(<BillsIndexClient initialBills={bills} vendors={[]} initialFilter={billFilter} />);
    expect(rowLinks().sort()).toEqual(["BL-1", "BL-2", "BL-3", "BL-4"]);
    expect(screen.queryByText(/voided bills? hidden/)).toBeNull();
    await userEvent.setup().click(screen.getByRole("checkbox", { name: "Show voided (2)" }));
    expect(nav.router.push).toHaveBeenCalledWith("/staff/admin/accounting/ap/bills", { scroll: false });
  });

  it("keeps ?voided=1 on the sort links", () => {
    setParams("voided=1");
    render(<BillsIndexClient initialBills={bills} vendors={[]} initialFilter={billFilter} />);
    const vendorSort = within(screen.getByRole("table")).getByRole("link", { name: /Vendor/ });
    expect(vendorSort.getAttribute("href")).toContain("voided=1");
  });

  it("a Voided status filter shows them regardless, with the switch locked on", () => {
    setParams("status=voided");
    render(<BillsIndexClient initialBills={[bill("2", "voided")]} vendors={[]} initialFilter={{ ...billFilter, status: "voided" }} />);
    expect(rowLinks()).toEqual(["BL-2"]);
    const box = screen.getByRole("checkbox", { name: "Show voided (1)" });
    expect((box as HTMLInputElement).checked).toBe(true);
    expect((box as HTMLInputElement).disabled).toBe(true);
  });

  it("when every bill is voided, says so with a link instead of 'no bills match'", () => {
    render(<BillsIndexClient initialBills={[bill("2", "voided"), bill("4", "voided")]} vendors={[]} initialFilter={billFilter} />);
    expect(screen.queryByText("No bills match your filters.")).toBeNull();
    expect(screen.getByText(/No active bills match your filters\. 2 voided bills are hidden/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "show voided" }).getAttribute("href")).toBe("/staff/admin/accounting/ap/bills?voided=1");
  });

  it("keeps the plain empty state when nothing at all matches", () => {
    render(<BillsIndexClient initialBills={[]} vendors={[]} initialFilter={billFilter} />);
    expect(screen.getByText("No bills match your filters.")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Show voided" })).toBeTruthy();
  });
});

describe("AP Bill Payments list — voided payments", () => {
  const payments = [payment("1", false), payment("2", true), payment("3", true)];

  it("hides voided payments by default and says how many", () => {
    render(<PaymentsIndexClient initialPayments={payments} vendors={[]} initialFilter={payFilter} />);
    expect(rowLinks()).toEqual(["BP-1"]);
    expect((screen.getByRole("checkbox", { name: "Show voided (2)" }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText("2 voided payments hidden.")).toBeTruthy();
  });

  it("ticking Show voided navigates to ?voided=1, keeping filters", async () => {
    setParams("method=cash&page=3");
    render(<PaymentsIndexClient initialPayments={payments} vendors={[]} initialFilter={payFilter} />);
    await userEvent.setup().click(screen.getByRole("checkbox", { name: "Show voided (2)" }));
    expect(nav.router.push).toHaveBeenCalledWith(
      "/staff/admin/accounting/ap/payments?method=cash&voided=1",
      { scroll: false },
    );
  });

  it("shows voided payments with ?voided=1", () => {
    setParams("voided=1");
    render(<PaymentsIndexClient initialPayments={payments} vendors={[]} initialFilter={payFilter} />);
    expect(rowLinks().sort()).toEqual(["BP-1", "BP-2", "BP-3"]);
    expect((screen.getByRole("checkbox", { name: "Show voided (2)" }) as HTMLInputElement).checked).toBe(true);
  });

  it("when every payment is voided, says so with a link", () => {
    render(<PaymentsIndexClient initialPayments={[payment("2", true)]} vendors={[]} initialFilter={payFilter} />);
    expect(screen.getByText(/No active payments match your filters\. 1 voided payment is hidden/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "show voided" }).getAttribute("href")).toBe("/staff/admin/accounting/ap/payments?voided=1");
  });
});
