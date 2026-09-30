// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: unknown[] = [];
const router = vi.hoisted(() => ({ refresh: vi.fn() }));
let reply: unknown;
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/app/(staff)/staff/(dashboard)/queue/actions", () => ({
  releaseTestsAction: async (input: unknown) => {
    calls.push(input);
    return reply;
  },
}));

import { QueueReleaseButton } from "./queue-release-button";
import { ReleaseOutcomeProvider } from "./release-outcome";

beforeEach(() => {
  calls.length = 0;
  router.refresh.mockClear();
  reply = { ok: true, changedIds: ["t1"], skipped: [], alsoReleasedIds: [], warnings: [] };
});
afterEach(cleanup);

describe("QueueReleaseButton", () => {
  it("is disabled and explains why when blocked", () => {
    render(
      <QueueReleaseButton
        testRequestIds={["t1"]}
        preferredMedium={null}
        blockReason="Visit must be paid, waived, or HMO-covered before results can be released."
      />,
    );
    expect((screen.getByRole("button", { name: "Release" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Visit must be paid/)).toBeTruthy();
  });

  it("sends the ids and the patient's preferred medium, then refreshes", async () => {
    render(<QueueReleaseButton testRequestIds={["t1", "t2"]} preferredMedium="email" blockReason={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    await waitFor(() => expect(calls).toEqual([{ testRequestIds: ["t1", "t2"], medium: "email" }]));
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it("shows a server refusal inline when there is no provider", async () => {
    reply = {
      ok: true,
      changedIds: [],
      skipped: [{ id: "t1", reason: "Part of this combined report isn't finished — 1 test is still awaiting a result or sign-off." }],
      alsoReleasedIds: [],
      warnings: [],
    };
    render(<QueueReleaseButton testRequestIds={["t1"]} preferredMedium={null} blockReason={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    expect((await screen.findByRole("status")).textContent).toContain("isn't finished");
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("shows an input error inline even inside a provider", async () => {
    reply = { ok: false, error: "Nothing to release." };
    render(
      <ReleaseOutcomeProvider>
        <QueueReleaseButton testRequestIds={["t1"]} preferredMedium={null} blockReason={null} />
      </ReleaseOutcomeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    expect((await screen.findByRole("status")).textContent).toContain("Nothing to release.");
  });

  it("reports through the provider so the notice outlives the button", async () => {
    reply = {
      ok: true,
      changedIds: ["t1"],
      skipped: [{ id: "t3", reason: "Part of this combined report isn't finished — 1 test is still awaiting a result or sign-off." }],
      alsoReleasedIds: ["t2"],
      warnings: [],
    };
    const { rerender } = render(
      <ReleaseOutcomeProvider>
        <QueueReleaseButton testRequestIds={["t1"]} preferredMedium={null} blockReason={null} />
      </ReleaseOutcomeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    await screen.findByRole("status");
    // The refresh removes the pending row — the button unmounts.
    rerender(<ReleaseOutcomeProvider>{null}</ReleaseOutcomeProvider>);
    const notice = screen.getByRole("status").textContent ?? "";
    expect(notice).toContain("isn't finished");
    expect(notice).toContain("Also released 1 other test");
    expect(screen.queryByRole("button", { name: "Release" })).toBeNull();
  });
});
