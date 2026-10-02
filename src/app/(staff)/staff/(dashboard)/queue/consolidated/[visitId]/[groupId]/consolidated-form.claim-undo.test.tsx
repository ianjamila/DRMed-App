// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({ claimConsolidated: vi.fn(), finaliseConsolidated: vi.fn() }));

import { claimConsolidated } from "./actions";
import { ConsolidatedForm } from "./consolidated-form";
import type { ConsolidatedFormTemplate, ConsolidatedFormVisit } from "./page";

// The report page's own Claim hands the page its Undo notice through the same
// ?claimed=<batch>&at=<ms> handshake the queue row's Claim uses.

const VISIT = "11111111-1111-4111-8111-111111111111";
const GROUP = "22222222-2222-4222-8222-222222222222";
const BATCH = "0b7c3d2e-1111-4111-8111-000000000001";

function form() {
  return (
    <ConsolidatedForm
      group={{ id: GROUP, code: "CHEM", name: "Chemistry" }}
      template={{ id: "t1", layout: "x", header_notes: null, footer_notes: null, result_template_params: [] } as ConsolidatedFormTemplate}
      visit={{ id: VISIT, patients: { sex: "male" } } as unknown as ConsolidatedFormVisit}
      orderedServiceCodes={[]}
      testRequestIds={["m1", "m2"]}
      enabledParamIds={[]}
      claimedBy={null}
      myStaffId="me"
      claimBlockedHint={null}
      hasFinishedReports={false}
    />
  );
}

beforeEach(() => {
  vi.mocked(claimConsolidated).mockReset();
  router.replace.mockReset();
  router.refresh.mockReset();
});
afterEach(cleanup);

describe("ConsolidatedForm Claim", () => {
  it("sends the visit and group, then replaces the URL with the Undo handshake", async () => {
    vi.mocked(claimConsolidated).mockResolvedValue({ ok: true, batchId: BATCH });
    render(form());
    await userEvent.setup().click(screen.getByRole("button", { name: "Claim this report" }));

    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledTimes(1));
    expect(claimConsolidated).toHaveBeenCalledWith({ visitId: VISIT, groupId: GROUP, testRequestIds: ["m1", "m2"] });
    const [href, opts] = router.replace.mock.calls[0]!;
    expect(href).toMatch(new RegExp(`^/staff/queue/consolidated/${VISIT}/${GROUP}\\?claimed=${BATCH}&at=\\d+$`));
    expect(opts).toEqual({ scroll: false });
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("falls back to a plain refresh when the claim minted no batch", async () => {
    vi.mocked(claimConsolidated).mockResolvedValue({ ok: true });
    render(form());
    await userEvent.setup().click(screen.getByRole("button", { name: "Claim this report" }));

    await vi.waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("shows a refusal and navigates nowhere", async () => {
    vi.mocked(claimConsolidated).mockResolvedValue({ ok: false, error: "Some tests in this report were already claimed or changed status." });
    render(form());
    await userEvent.setup().click(screen.getByRole("button", { name: "Claim this report" }));

    expect(await screen.findByText(/already claimed or changed status/)).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
  });
});
