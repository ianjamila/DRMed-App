// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({ releaseTestsAction: vi.fn(), undoBulkQueueAction: vi.fn() }));
vi.mock("./panel-actions", () => ({
  claimQueueSelectionAction: vi.fn(),
  unclaimQueueSelectionAction: vi.fn(),
  deleteQueueSelectionAction: vi.fn(),
}));
vi.mock("../visits/[id]/actions", () => ({ deleteSampleVisitsFromQueueAction: vi.fn() }));

import { deleteSampleVisitsFromQueueAction } from "../visits/[id]/actions";
import { QueueBulkBar } from "./queue-bulk-bar";
import { SelectionProvider } from "@/components/staff/row-selection/selection-context";
import { RowSelectCheckbox } from "@/components/staff/row-selection/row-select-checkbox";
import {
  QUEUE_KIND,
  canDeleteSampleVisit,
  queueRowKinds,
  queueSelectable,
  sampleDeleteVisitIds,
  samplePaymentBlock,
  type QueueRowInfo,
} from "@/lib/queue/bulk-queue";

const SAMPLE = QUEUE_KIND.sampleDelete;
interface Row {
  key: string;
  kinds: string[];
  visitId: string;
}
const rowsByKeyOf = (rows: Row[]): Record<string, QueueRowInfo> =>
  Object.fromEntries(
    rows.map((r) => [
      r.key,
      { visitId: r.visitId, label: r.key, assignedTo: null, visitLabel: `Visit #${r.visitId} — Pt ${r.visitId}` },
    ]),
  );

function Harness({ rows }: { rows: Row[] }) {
  return (
    <SelectionProvider resetKey="k">
      {rows.map((r) => (
        <RowSelectCheckbox key={r.key} rowKey={r.key} kinds={r.kinds} label={r.key} />
      ))}
      <QueueBulkBar rowsByKey={rowsByKeyOf(rows)} />
    </SelectionProvider>
  );
}

beforeEach(() => {
  vi.mocked(deleteSampleVisitsFromQueueAction).mockReset();
  router.refresh.mockReset();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(cleanup);

describe("Delete N sample visits… in the bulk bar", () => {
  it("counts DISTINCT visits and offers no other action on a released-today style selection", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        rows={[
          { key: "a1", kinds: [SAMPLE], visitId: "A" },
          { key: "a2", kinds: [SAMPLE], visitId: "A" },
          { key: "b1", kinds: [SAMPLE], visitId: "B" },
        ]}
      />,
    );
    for (const k of ["a1", "a2", "b1"]) await user.click(screen.getByRole("checkbox", { name: `Select ${k}` }));
    expect(screen.getByRole("button", { name: "Delete 2 sample visits…" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Claim/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Release/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Delete \(/ })).toBeNull();
    // Only the sample action is on offer, so the bar counts visits.
    expect(screen.getByText(/sample visits selected/)).toBeTruthy();
  });

  it("a mixed selection (sample + non-sample) does not offer it", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        rows={[
          { key: "s", kinds: [QUEUE_KIND.claim, SAMPLE], visitId: "A" },
          { key: "n", kinds: [QUEUE_KIND.claim], visitId: "B" },
        ]}
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Select s" }));
    expect(screen.getByRole("button", { name: "Delete 1 sample visit…" })).toBeTruthy();
    await user.click(screen.getByRole("checkbox", { name: "Select n" }));
    expect(screen.queryByRole("button", { name: /sample visit/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Claim/ })).toBeTruthy();
  });

  it("confirms with a reason + tick, sends the distinct visit ids, and names every skipped visit with why", async () => {
    const user = userEvent.setup();
    vi.mocked(deleteSampleVisitsFromQueueAction).mockResolvedValue({
      ok: true,
      deletedVisitIds: ["A"],
      skipped: [{ id: "B", reason: "Has recorded payments — void them first." }],
      unreleasedCount: 3,
    });
    render(
      <Harness
        rows={[
          { key: "a1", kinds: [SAMPLE], visitId: "A" },
          { key: "a2", kinds: [SAMPLE], visitId: "A" },
          { key: "b1", kinds: [SAMPLE], visitId: "B" },
        ]}
      />,
    );
    for (const k of ["a1", "a2", "b1"]) await user.click(screen.getByRole("checkbox", { name: `Select ${k}` }));
    await user.click(screen.getByRole("button", { name: "Delete 2 sample visits…" }));
    expect(screen.getByText(/released results are un-released first/)).toBeTruthy();
    expect(screen.getByText(/patient is not contacted/)).toBeTruthy();

    const confirm = screen.getByRole("button", { name: "Confirm delete 2 sample visits" });
    await user.click(confirm);
    expect(screen.getByText("Reason is required.")).toBeTruthy();
    await user.type(screen.getByLabelText("Reason for deleting"), "demo data");
    await user.click(confirm);
    expect(screen.getByText(/Tick the box/)).toBeTruthy();
    expect(deleteSampleVisitsFromQueueAction).not.toHaveBeenCalled();
    await user.click(screen.getByRole("checkbox", { name: /sample or test visits/ }));
    await user.click(confirm);

    await waitFor(() => expect(deleteSampleVisitsFromQueueAction).toHaveBeenCalledWith(["A", "B"], "demo data"));
    await waitFor(() => expect(screen.getByText(/Deleted 1 of 2 sample visits\./)).toBeTruthy());
    expect(screen.getByText(/Visit #B — Pt B: Has recorded payments — void them first\./)).toBeTruthy();
    expect(screen.getByText(/Un-released 3 results first\./)).toBeTruthy();
    expect(router.refresh).toHaveBeenCalled();
  });
});

describe("sampleDeleteVisitIds / row predicates", () => {
  const rows = rowsByKeyOf([
    { key: "a1", kinds: [], visitId: "A" },
    { key: "a2", kinds: [], visitId: "A" },
    { key: "b1", kinds: [], visitId: "B" },
  ]);
  it("dedupes visits", () => {
    expect(sampleDeleteVisitIds(3, ["a1", "a2", "b1"], rows)).toEqual(["A", "B"]);
  });
  it("is empty when any selected row is not a sample row", () => {
    expect(sampleDeleteVisitIds(3, ["a1", "a2"], rows)).toEqual([]);
    expect(sampleDeleteVisitIds(0, [], rows)).toEqual([]);
  });
  it("only an admin, only on a sample visit", () => {
    expect(canDeleteSampleVisit("admin", true)).toBe(true);
    expect(canDeleteSampleVisit("admin", false)).toBe(false);
    for (const role of ["reception", "lab_tech", "pathologist", "doctor"]) {
      expect(canDeleteSampleVisit(role, true)).toBe(false);
    }
  });
  it("released-today checkboxes exist for admins only; worklists unchanged; reception never", () => {
    expect(queueSelectable({ role: "admin", receptionView: false, releasedTab: true })).toBe(true);
    expect(queueSelectable({ role: "lab_tech", receptionView: false, releasedTab: true })).toBe(false);
    expect(queueSelectable({ role: "pathologist", receptionView: false, releasedTab: true })).toBe(false);
    expect(queueSelectable({ role: "lab_tech", receptionView: false, releasedTab: false })).toBe(true);
    expect(queueSelectable({ role: "reception", receptionView: true, releasedTab: false })).toBe(false);
    expect(queueSelectable({ role: "reception", receptionView: true, releasedTab: true })).toBe(false);
  });
  it("a recorded payment or waived balance blocks a sample row (hint shown, kind withheld); HMO/lines stay server-side", () => {
    expect(samplePaymentBlock("admin", "unpaid")).toBeNull();
    expect(samplePaymentBlock("admin", "paid")).toBe("Has recorded payments — void them first.");
    expect(samplePaymentBlock("admin", "partial")).toBe("Has recorded payments — void them first.");
    expect(samplePaymentBlock("admin", "waived")).toBe("Balance was waived — deletion not available.");
    // A role that cannot delete gets no payment hint (the row action is hidden anyway).
    expect(samplePaymentBlock("lab_tech", "paid")).toBeNull();
  });
  it("a sample row on released today carries only the sample kind; a non-sample row carries none", () => {
    const only = { claimable: false, unclaimable: false, releasable: false, deletable: false };
    expect(queueRowKinds({ ...only, sampleDeletable: canDeleteSampleVisit("admin", true) })).toEqual([SAMPLE]);
    expect(queueRowKinds({ ...only, sampleDeletable: canDeleteSampleVisit("admin", false) })).toEqual([]);
    expect(queueRowKinds({ ...only, sampleDeletable: canDeleteSampleVisit("lab_tech", true) })).toEqual([]);
  });
});
