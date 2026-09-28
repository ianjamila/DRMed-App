// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./actions", () => ({ editPaymentAction: vi.fn() }));

import { editPaymentAction } from "./actions";
import { EditPaymentDialog } from "./edit-payment-dialog";
import type { ReleasedCounts, VisitMoney } from "@/lib/visits/payment-edit";

// PR #213 + #224: editing a payment (amount/method/reference/notes) with a
// reason, guarded against a stale read (0174's `p_expected`). Pins: the
// dialog opens pre-filled with the CURRENT payment, an invalid amount or an
// empty reason blocks Save before editPaymentAction is ever called, a
// successful save sends both the new fields AND a snapshot of the payment as
// it was when the dialog opened (the stale-guard payload correct_payment
// checks under its row lock), a refused save keeps the dialog and the typed
// values, and a waived visit's locked amount cannot be typed into.

const NO_RELEASED: ReleasedCounts = { results: 0, consults: 0, procedures: 0 };
const SETTLED_VISIT: VisitMoney = {
  totalPhp: 500,
  paidPhp: 500,
  paymentStatus: "paid",
  hmoProviderId: null,
};

function dialog(overrides: Partial<Parameters<typeof EditPaymentDialog>[0]> = {}) {
  return (
    <EditPaymentDialog
      paymentId="p1"
      amount={500}
      method="cash"
      methodLabel="Cash"
      referenceNumber="OR-1"
      notes="counter note"
      receivedLabel="today"
      receivedOnOtherDay={null}
      visitTotal={500}
      visitPaid={500}
      visit={SETTLED_VISIT}
      visitNumber="0042"
      released={NO_RELEASED}
      {...overrides}
    />
  );
}

beforeEach(() => {
  vi.mocked(editPaymentAction).mockReset();
});
afterEach(cleanup);

describe("EditPaymentDialog", () => {
  it("opens pre-filled with the payment's current values", async () => {
    const user = userEvent.setup();
    render(dialog());
    await user.click(screen.getByRole("button", { name: "Edit" }));

    expect((screen.getByLabelText("Method") as HTMLSelectElement).value).toBe("cash");
    expect((screen.getByLabelText("Amount (PHP)") as HTMLInputElement).value).toBe("500.00");
    expect((screen.getByLabelText("Reference number (optional)") as HTMLInputElement).value).toBe("OR-1");
    expect((screen.getByLabelText("Notes (optional)") as HTMLTextAreaElement).value).toBe("counter note");
  });

  it("blocks Save on an invalid amount, then on a valid change with no reason yet", async () => {
    const user = userEvent.setup();
    render(dialog());
    await user.click(screen.getByRole("button", { name: "Edit" }));

    const amountInput = screen.getByLabelText("Amount (PHP)");
    await user.clear(amountInput);
    await user.type(amountInput, "0");
    expect(screen.getByText("Enter an amount greater than zero.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);

    await user.clear(amountInput);
    await user.type(amountInput, "750");
    expect(screen.getByText(/moves to the/)).toBeTruthy(); // moneyChanged preview
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true); // still no reason
    expect(editPaymentAction).not.toHaveBeenCalled();
  });

  it("sends the new fields plus a snapshot of the ORIGINAL payment as the stale guard, then closes", async () => {
    vi.mocked(editPaymentAction).mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(dialog());
    await user.click(screen.getByRole("button", { name: "Edit" }));

    const amountInput = screen.getByLabelText("Amount (PHP)");
    await user.clear(amountInput);
    await user.type(amountInput, "750");
    await user.type(screen.getByLabelText(/Why are you changing it/), "Patient paid more by GCash");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(editPaymentAction).toHaveBeenCalledWith({
      paymentId: "p1",
      amount: "750",
      method: "cash",
      referenceNumber: "OR-1",
      notes: "counter note",
      reason: "Patient paid more by GCash",
      expected: { amount_php: 500, method: "cash", reference_number: "OR-1", notes: "counter note" },
    });
    expect(screen.queryByText("Edit payment")).toBeNull(); // dialog closed
  });

  it("a refused (stale) save shows the error and keeps the dialog with what was typed", async () => {
    vi.mocked(editPaymentAction).mockResolvedValue({
      ok: false,
      error: "Someone else edited this payment since you opened this.",
    });
    const user = userEvent.setup();
    render(dialog());
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const amountInput = screen.getByLabelText("Amount (PHP)");
    await user.clear(amountInput);
    await user.type(amountInput, "750");
    await user.type(screen.getByLabelText(/Why are you changing it/), "Patient paid more by GCash");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Someone else edited this payment since you opened this.",
    );
    expect(screen.getByText("Edit payment")).toBeTruthy(); // still open
    expect((amountInput as HTMLInputElement).value).toBe("750"); // not reset
  });

  it("locks the amount field on a waived visit and says why", async () => {
    const user = userEvent.setup();
    render(dialog({ amountLocked: true }));
    await user.click(screen.getByRole("button", { name: "Edit" }));

    expect((screen.getByLabelText("Amount (PHP)") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("Fixed — the balance on this visit was waived.")).toBeTruthy();
  });
});
