// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./actions", () => ({ voidPaymentAction: vi.fn() }));
vi.mock("@/components/staff/payment-dialog-handoff", () => ({
  openPaymentDialog: vi.fn(),
}));

import { voidPaymentAction } from "./actions";
import { VoidPaymentDialog } from "./void-payment-dialog";
import type { ReleasedCounts, VisitMoney } from "@/lib/visits/payment-edit";

// PR #213 + #224: deleting (soft-voiding) a payment. Staff pick why from a
// fixed set of categories; "Other" additionally requires a typed note before
// Delete unlocks (the other categories don't). Pins: that category gate, the
// "Open Move/Edit instead" handoff appearing ONLY when the payment is one
// Move/Edit would actually accept (canMoveOrEdit — offering it on a payment
// they'd refuse would be a dead end), a refused delete (voidPaymentAction's
// own "already changed" guard) keeping the dialog and the picked category on
// screen, and the "what this leaves the visit in" preview actually being the
// shared PaymentLeavesNotice, not a component-local rewrite of it.

const NO_RELEASED: ReleasedCounts = { results: 0, consults: 0, procedures: 0 };

function dialog(overrides: Partial<Parameters<typeof VoidPaymentDialog>[0]> = {}) {
  const visit: VisitMoney = overrides.visit ?? {
    totalPhp: 500,
    paidPhp: 500,
    paymentStatus: "paid",
    hmoProviderId: null,
  };
  return (
    <VoidPaymentDialog
      paymentId="p1"
      amount={500}
      amountLabel="₱500"
      methodLabel="Cash"
      visitNumber="0042"
      visit={visit}
      released={overrides.released ?? NO_RELEASED}
      canMoveOrEdit={overrides.canMoveOrEdit ?? true}
      {...overrides}
    />
  );
}

beforeEach(() => {
  vi.mocked(voidPaymentAction).mockReset();
});
afterEach(cleanup);

describe("VoidPaymentDialog", () => {
  it("'Other' needs a typed note before Delete unlocks; the other categories don't", async () => {
    vi.mocked(voidPaymentAction).mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(dialog());
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await user.click(screen.getByRole("radio", { name: "Recorded twice" }));
    expect((screen.getByRole("button", { name: "Delete payment" }) as HTMLButtonElement).disabled).toBe(false);

    await user.click(screen.getByRole("radio", { name: "Other" }));
    expect((screen.getByRole("button", { name: "Delete payment" }) as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByLabelText("What happened? *"), "Refunded by bank transfer instead");
    expect((screen.getByRole("button", { name: "Delete payment" }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole("button", { name: "Delete payment" }));

    expect(voidPaymentAction).toHaveBeenCalledWith("p1", {
      category: "other",
      reason: "Refunded by bank transfer instead",
    });
    expect(screen.queryByText(/^Delete this/)).toBeNull(); // dialog closed
  });

  it("offers the Move/Edit handoff only when the payment is one they'd actually accept", async () => {
    const user = userEvent.setup();
    render(dialog({ canMoveOrEdit: true }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("radio", { name: "Wrong visit" }));
    expect(screen.getByRole("button", { name: "Open Move instead" })).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: "Wrong amount" }));
    expect(screen.getByRole("button", { name: "Open Edit instead" })).toBeTruthy();

    cleanup();
    render(dialog({ canMoveOrEdit: false }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("radio", { name: "Wrong visit" }));
    expect(screen.queryByRole("button", { name: "Open Move instead" })).toBeNull();
  });

  it("a refused delete shows the error and keeps the dialog and the chosen category", async () => {
    vi.mocked(voidPaymentAction).mockResolvedValue({
      ok: false,
      error: "Someone else already deleted, edited or moved this payment. Refresh the visit.",
    });
    const user = userEvent.setup();
    render(dialog());
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("radio", { name: "Recorded twice" }));
    await user.click(screen.getByRole("button", { name: "Delete payment" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Someone else already deleted, edited or moved this payment. Refresh the visit.",
    );
    expect(screen.getByText(/^Delete this/)).toBeTruthy(); // still open
    expect((screen.getByRole("radio", { name: "Recorded twice" }) as HTMLInputElement).checked).toBe(true);
  });

  it("shows the shared what-this-leaves-the-visit preview when the visit will owe again", async () => {
    const user = userEvent.setup();
    render(
      dialog({
        visit: { totalPhp: 1000, paidPhp: 500, paymentStatus: "partial", hmoProviderId: null },
        amount: 500,
        released: { results: 1, consults: 0, procedures: 0 },
      }),
    );
    await user.click(screen.getByRole("button", { name: "Delete" }));

    const notice = screen.getByTestId("payment-leaves-notice");
    expect(notice.textContent).toContain("Visit #0042 will then owe");
    expect(notice.textContent).toContain("already released");
  });
});
