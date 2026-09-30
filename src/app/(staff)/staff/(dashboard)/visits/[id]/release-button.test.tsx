// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: unknown[][] = [];
let reply: unknown;
vi.mock("./actions", () => ({
  releaseTestAction: async (...a: unknown[]) => {
    calls.push(a);
    return reply;
  },
}));

import { ReleaseOutcomeProvider } from "@/components/staff/release/release-outcome";
import { REPORT_REFUSAL } from "@/lib/queue/report-release-scope";
import { ReleaseButton } from "./release-button";

const base = {
  testRequestId: "t1",
  visitId: "v1",
  moneySettled: true,
  preferredMedium: "email" as const,
  consentOnFile: true,
  gateRequired: false,
};

beforeEach(() => {
  calls.length = 0;
  reply = { ok: true, changedCount: 1, alsoReleasedCount: 0, skipped: [], warnings: [] };
  vi.stubGlobal("alert", vi.fn());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ReleaseButton", () => {
  it("is disabled and shows the reason when the combined report is blocked", () => {
    render(<ReleaseButton {...base} label="Release report (3 tests)" blockReason={REPORT_REFUSAL.notFinished(1)} />);
    const btn = screen.getByRole("button", { name: "Release report (3 tests)" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(REPORT_REFUSAL.notFinished(1))).toBeTruthy();
    fireEvent.click(btn);
    expect(calls).toHaveLength(0);
  });

  it("labels a plain row Release and sends the chosen medium", async () => {
    render(<ReleaseButton {...base} />);
    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    await waitFor(() => expect(calls).toEqual([["t1", "v1", "email"]]));
  });

  it("keeps the pulled-in note after the button unmounts on refresh", async () => {
    reply = { ok: true, changedCount: 1, alsoReleasedCount: 2, skipped: [], warnings: [] };
    const tree = (withButton: boolean) => (
      <ReleaseOutcomeProvider>
        {withButton ? <ReleaseButton {...base} label="Release report (3 tests)" /> : null}
      </ReleaseOutcomeProvider>
    );
    const { rerender } = render(tree(true));
    fireEvent.click(screen.getByRole("button", { name: "Release report (3 tests)" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "Also released 2 other tests on the same combined report.",
      ),
    );
    rerender(tree(false));
    expect(screen.queryByRole("button", { name: /Release/ })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      "Also released 2 other tests on the same combined report.",
    );
    expect(alert).not.toHaveBeenCalled();
  });

  it("shows a refusal in the provider, and falls back to alert without one", async () => {
    reply = { ok: false, error: REPORT_REFUSAL.deletedMember };
    render(
      <ReleaseOutcomeProvider>
        <ReleaseButton {...base} />
      </ReleaseOutcomeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    expect((await screen.findByRole("status")).textContent).toContain(REPORT_REFUSAL.deletedMember);
    cleanup();
    render(<ReleaseButton {...base} />);
    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    await waitFor(() => expect(alert).toHaveBeenCalledWith(REPORT_REFUSAL.deletedMember));
  });
});
