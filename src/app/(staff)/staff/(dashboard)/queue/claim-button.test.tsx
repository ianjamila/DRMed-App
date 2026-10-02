// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({ claimTestAction: vi.fn() }));
vi.mock("./panel-actions", () => ({ claimPanelAction: vi.fn() }));

import { claimTestAction } from "./actions";
import { claimPanelAction } from "./panel-actions";
import { ClaimButton } from "./claim-button";

const BATCH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PANEL = { visitId: "v1", groupId: "g1" };

const alertSpy = vi.fn();
beforeEach(() => {
  vi.mocked(claimTestAction).mockReset();
  vi.mocked(claimPanelAction).mockReset();
  router.push.mockReset();
  router.replace.mockReset();
  router.refresh.mockReset();
  alertSpy.mockReset();
  vi.stubGlobal("alert", alertSpy);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function clickClaim() {
  await userEvent.click(screen.getByRole("button", { name: "Claim" }));
}

describe("ClaimButton: single test", () => {
  it("on the queue row, a claim with a batch pushes the bench URL carrying it", async () => {
    vi.mocked(claimTestAction).mockResolvedValue({ ok: true, batchId: BATCH });
    render(<ClaimButton testRequestId="t1" navigateOnClaim />);
    await clickClaim();
    await waitFor(() => expect(router.push).toHaveBeenCalledTimes(1));
    expect(router.push.mock.calls[0][0]).toMatch(new RegExp(`^/staff/queue/t1\\?claimed=${BATCH}&at=\\d+$`));
    expect(claimTestAction).toHaveBeenCalledWith("t1");
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("on the bench page's own button, a claim with a batch replaces the URL (no push)", async () => {
    vi.mocked(claimTestAction).mockResolvedValue({ ok: true, batchId: BATCH });
    render(<ClaimButton testRequestId="t1" />);
    await clickClaim();
    await waitFor(() => expect(router.replace).toHaveBeenCalledTimes(1));
    const [href, opts] = router.replace.mock.calls[0];
    expect(href).toMatch(new RegExp(`^/staff/queue/t1\\?claimed=${BATCH}&at=\\d+$`));
    expect(opts).toEqual({ scroll: false });
    expect(router.push).not.toHaveBeenCalled();
  });

  it("with no batch, the queue row pushes the bare bench URL", async () => {
    vi.mocked(claimTestAction).mockResolvedValue({ ok: true });
    render(<ClaimButton testRequestId="t1" navigateOnClaim />);
    await clickClaim();
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/staff/queue/t1"));
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("with no batch, the bench page's own button navigates nowhere (the action's revalidate refreshes it)", async () => {
    vi.mocked(claimTestAction).mockResolvedValue({ ok: true });
    render(<ClaimButton testRequestId="t1" />);
    await clickClaim();
    await waitFor(() => expect(claimTestAction).toHaveBeenCalled());
    await waitFor(() => expect((screen.getByRole("button", { name: "Claim" }) as HTMLButtonElement).disabled).toBe(false));
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it.each([true, false])("an error alerts and does not navigate (navigateOnClaim=%s)", async (nav) => {
    vi.mocked(claimTestAction).mockResolvedValue({ ok: false, error: "Someone else holds this now." });
    render(<ClaimButton testRequestId="t1" navigateOnClaim={nav} />);
    await clickClaim();
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("Someone else holds this now."));
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("ClaimButton: panel", () => {
  it("pushes the report URL carrying the panel's batch", async () => {
    vi.mocked(claimPanelAction).mockResolvedValue({ ok: true, batchId: BATCH });
    render(<ClaimButton panel={PANEL} navigateOnClaim />);
    await clickClaim();
    await waitFor(() => expect(router.push).toHaveBeenCalledTimes(1));
    expect(router.push.mock.calls[0][0]).toMatch(
      new RegExp(`^/staff/queue/consolidated/v1/g1\\?claimed=${BATCH}&at=\\d+$`),
    );
    expect(claimPanelAction).toHaveBeenCalledWith(PANEL);
    expect(claimTestAction).not.toHaveBeenCalled();
  });

  it("with no batch, pushes the bare report URL", async () => {
    vi.mocked(claimPanelAction).mockResolvedValue({ ok: true });
    render(<ClaimButton panel={PANEL} navigateOnClaim />);
    await clickClaim();
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/staff/queue/consolidated/v1/g1"));
  });
});
