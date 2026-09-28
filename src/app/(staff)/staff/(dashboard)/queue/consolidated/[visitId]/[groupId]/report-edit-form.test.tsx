// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({ amendConsolidated: vi.fn() }));

import { amendConsolidated } from "./actions";
import { ReportEditForm } from "./report-edit-form";
import type { ConsolidatedParam, ValueCells } from "./consolidated-values-table";

// X2: saving an edit revalidates the page, and a revalidating Server Action
// ships the re-rendered route — with the bumped amendment_count — in its own
// response. The edit fields are keyed by that count so a form seeded from old
// values can never save over a newer version; the "Saved." panel therefore
// lives ABOVE that key, in ReportEditForm, which the page keys by report only.
// A re-render with a newer count below stands in for that revalidation.

const FBS = {
  id: "p1",
  parameter_name: "FBS",
  si_to_conv_factor: null,
  unit_si: "mmol/L",
  unit_conv: "mg/dL",
} as unknown as ConsolidatedParam;
const DONE = "/staff/queue/consolidated/v1/g1#result-r1";

function form(count: number, si: string) {
  const initial: ValueCells = { p1: { si, conv: "" } };
  return (
    <ReportEditForm
      key="r1"
      resultId="r1"
      expectedAmendmentCount={count}
      params={[FBS]}
      editableParamIds={["p1"]}
      initial={initial}
      notifyOffer={{ offered: true }}
      doneHref={DONE}
    />
  );
}

beforeEach(() => {
  vi.mocked(amendConsolidated).mockReset();
  router.replace.mockReset();
  router.refresh.mockReset();
});
afterEach(cleanup);

describe("consolidated report edit", () => {
  it("keeps Saved + the notice outcome on screen through the save's revalidation, until Done", async () => {
    vi.mocked(amendConsolidated).mockResolvedValue({ ok: true, data: { amendmentSeq: 1 }, notify: "sent" });
    const user = userEvent.setup();
    const { rerender } = render(form(1, "5.4"));

    await user.clear(screen.getByLabelText("FBS SI result"));
    await user.type(screen.getByLabelText("FBS SI result"), "9.9");
    await user.type(screen.getByLabelText(/Reason for the edit/), "Glucose re-run");
    await user.click(screen.getByLabelText(/Let the patient know/));
    await user.click(screen.getByRole("button", { name: "Save edit" }));

    expect(await screen.findByRole("status")).toHaveProperty(
      "textContent",
      "Saved. The patient was sent an update notice.",
    );
    expect(amendConsolidated).toHaveBeenCalledWith(
      expect.objectContaining({ resultId: "r1", expectedAmendmentCount: 1, notifyPatient: true, reason: "Glucose re-run" }),
    );

    // The save's revalidation lands: same report, next version, new values.
    rerender(form(2, "9.9"));
    expect(screen.getByRole("status").textContent).toBe("Saved. The patient was sent an update notice.");
    expect(screen.queryByRole("button", { name: "Save edit" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(router.replace).toHaveBeenCalledWith(DONE);
    expect(router.refresh).toHaveBeenCalled();
  });

  it("a newer version arriving mid-edit resets the fields to it, so old values can't save over it", async () => {
    const user = userEvent.setup();
    const { rerender } = render(form(1, "5.4"));
    await user.type(screen.getByLabelText(/Reason for the edit/), "half-typed reason");

    rerender(form(2, "7.7")); // someone else's edit, picked up by a refresh

    expect((screen.getByLabelText("FBS SI result") as HTMLInputElement).value).toBe("7.7");
    expect((screen.getByLabelText(/Reason for the edit/) as HTMLTextAreaElement).value).toBe("");
    await user.type(screen.getByLabelText(/Reason for the edit/), "second attempt");
    vi.mocked(amendConsolidated).mockResolvedValue({ ok: true, data: { amendmentSeq: 2 } });
    await user.click(screen.getByRole("button", { name: "Save edit" }));
    expect(amendConsolidated).toHaveBeenCalledWith(expect.objectContaining({ expectedAmendmentCount: 2 }));
  });

  it("a refused save keeps the form and shows why", async () => {
    vi.mocked(amendConsolidated).mockResolvedValue({ ok: false, error: "Someone else edited this report.", stale: true });
    const user = userEvent.setup();
    render(form(1, "5.4"));
    await user.type(screen.getByLabelText(/Reason for the edit/), "Glucose re-run");
    await user.click(screen.getByRole("button", { name: "Save edit" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Someone else edited this report.");
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

// The component can only hold Saved across the revalidation if the PAGE does
// not remount it — i.e. keys it by report, never by version.
describe("the page mounts ReportEditForm by report only", () => {
  it("keys it by editing.resultId", () => {
    const pageSrc = readFileSync(
      join(process.cwd(), "src/app/(staff)/staff/(dashboard)/queue/consolidated/[visitId]/[groupId]/page.tsx"),
      "utf8",
    );
    const usage = pageSrc.slice(pageSrc.indexOf("<ReportEditForm"));
    expect(usage.match(/key=\{([^}]*)\}/)?.[1]).toBe("editing.resultId");
  });
});
