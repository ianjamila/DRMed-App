// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./actions", () => ({
  findVisitForMoveAction: vi.fn(),
  movePaymentAction: vi.fn(),
}));

import { findVisitForMoveAction, movePaymentAction } from "./actions";
import { MovePaymentDialog, type SamePatientVisit } from "./move-payment-dialog";
import type { ReleasedCounts, VisitMoney } from "@/lib/visits/payment-edit";

// PR #213 + #224: moving a payment onto another visit — either one of the
// same patient's OTHER live visits (a dropdown) or any visit by number (a
// lookup that re-checks it isn't the current visit and flags a different
// patient). Pins: picking a same-patient visit enables Move only once a
// reason is typed, a cross-patient lookup match is called out before
// moving, typing the CURRENT visit's own number is refused without ever
// enabling Move, and a refused move (movePaymentAction's own stale guard —
// 0174's `p_expected` under the row lock) keeps the dialog and the picked
// target on screen.

const NO_RELEASED: ReleasedCounts = { results: 0, consults: 0, procedures: 0 };
const CURRENT_VISIT: VisitMoney = { totalPhp: 500, paidPhp: 500, paymentStatus: "paid", hmoProviderId: null };

function dialog(overrides: Partial<Parameters<typeof MovePaymentDialog>[0]> = {}) {
  const otherVisits: SamePatientVisit[] = overrides.otherVisits ?? [];
  return (
    <MovePaymentDialog
      paymentId="p1"
      amount={500}
      methodLabel="Cash"
      currentVisitNumber="0042"
      patientName="Santos, Maria"
      patientDrmId="DRM-0001"
      otherVisits={otherVisits}
      currentVisit={CURRENT_VISIT}
      currentVisitReleased={NO_RELEASED}
      {...overrides}
    />
  );
}

beforeEach(() => {
  vi.mocked(findVisitForMoveAction).mockReset();
  vi.mocked(movePaymentAction).mockReset();
});
afterEach(cleanup);

describe("MovePaymentDialog", () => {
  it("picking one of the patient's own other visits shows the target, and Move needs a reason first", async () => {
    vi.mocked(movePaymentAction).mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(
      dialog({
        otherVisits: [{ id: "v2", visitNumber: "0099", visitDate: "2026-09-01", totalPhp: 1000, paidPhp: 0 }],
      }),
    );
    await user.click(screen.getByRole("button", { name: "Move" }));

    await user.selectOptions(screen.getByLabelText(/Another visit for/), "v2");
    expect(screen.getByText(/Visit #0099/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Move payment" }) as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByLabelText(/Why are you moving it/), "Recorded on the wrong visit");
    await user.click(screen.getByRole("button", { name: "Move payment" }));

    expect(movePaymentAction).toHaveBeenCalledWith({
      paymentId: "p1",
      targetVisitId: "v2",
      reason: "Recorded on the wrong visit",
    });
  });

  it("a looked-up visit belonging to a different patient is flagged before moving", async () => {
    vi.mocked(findVisitForMoveAction).mockResolvedValue({
      ok: true,
      visit: {
        id: "v3",
        visitNumber: "0077",
        visitDate: "2026-09-02",
        patientName: "Cruz, Juan",
        drmId: "DRM-9999",
        totalPhp: 500,
        paidPhp: 0,
      },
    });
    const user = userEvent.setup();
    render(dialog());
    await user.click(screen.getByRole("button", { name: "Move" }));

    await user.type(screen.getByLabelText("Visit number"), "0077");
    await user.click(screen.getByRole("button", { name: "Find" }));

    expect(await screen.findByText("This visit belongs to a different patient.")).toBeTruthy();
  });

  it("typing the CURRENT visit's own number is refused, and Move stays off", async () => {
    vi.mocked(findVisitForMoveAction).mockResolvedValue({
      ok: true,
      visit: {
        id: "self",
        visitNumber: "0042",
        visitDate: "2026-09-01",
        patientName: "Santos, Maria",
        drmId: "DRM-0001",
        totalPhp: 500,
        paidPhp: 500,
      },
    });
    const user = userEvent.setup();
    render(dialog());
    await user.click(screen.getByRole("button", { name: "Move" }));
    await user.type(screen.getByLabelText("Visit number"), "0042");
    await user.click(screen.getByRole("button", { name: "Find" }));

    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "The payment is already on this visit.");
    expect(screen.queryByText(/Visit #0042/)).toBeNull(); // no target summary was set
    await user.type(screen.getByLabelText(/Why are you moving it/), "reason");
    expect((screen.getByRole("button", { name: "Move payment" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a refused move keeps the dialog open with the error and the picked target", async () => {
    vi.mocked(movePaymentAction).mockResolvedValue({
      ok: false,
      error: "Someone else already deleted, edited or moved this payment. Refresh the visit.",
    });
    const user = userEvent.setup();
    render(
      dialog({
        otherVisits: [{ id: "v2", visitNumber: "0099", visitDate: "2026-09-01", totalPhp: 1000, paidPhp: 0 }],
      }),
    );
    await user.click(screen.getByRole("button", { name: "Move" }));
    await user.selectOptions(screen.getByLabelText(/Another visit for/), "v2");
    await user.type(screen.getByLabelText(/Why are you moving it/), "reason");
    await user.click(screen.getByRole("button", { name: "Move payment" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Someone else already deleted, edited or moved this payment. Refresh the visit.",
    );
    expect(screen.getByText("Move payment to another visit")).toBeTruthy(); // still open
    expect(screen.getByText(/Visit #0099/)).toBeTruthy(); // target still shown
  });
});
