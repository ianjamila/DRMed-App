// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({ bulkDeleteAction: vi.fn(), bulkTransitionAction: vi.fn() }));

import { bulkDeleteAction, bulkTransitionAction } from "./actions";
import { AppointmentsBulkBar } from "./appointments-bulk-bar";
import { SelectionProvider } from "@/components/staff/row-selection/selection-context";
import { RowSelectCheckbox } from "@/components/staff/row-selection/row-select-checkbox";
import { SelectAllCheckbox } from "@/components/staff/row-selection/select-all-checkbox";
import { outcomeMessage, summariseOutcome, type GroupInfo } from "@/lib/appointments/bulk-eligibility";
import type { SelectionEntry } from "@/lib/ui/bulk-selection";

// PR #238 (bulk booking actions on Appointments): the checkboxes
// (RowSelectCheckbox / SelectAllCheckbox), the shared SelectionProvider and
// AppointmentsBulkBar are all real here — only the two server actions and
// next/navigation are mocked, so this exercises the actual wiring the page
// uses (page.tsx composes the same four pieces around the same
// groupsByKey/resetKey contract). Pins: which buttons a selection unlocks
// (bulkActionPlan, driven by each row's status/patientActive), that a
// filter/list change (resetKey) drops the selection without remounting
// anything else, that a bulk button sends exactly the selected ids plus the
// expected "from" status, that a confirm-guarded action can be cancelled,
// that a partial/refused result is shown to the operator, and that a
// successful or partial send always prunes what it sent (the alert is the
// record) while a refused one keeps the selection for retry.

interface Row {
  key: string;
  ids: string[];
  status: string;
  patientActive?: boolean;
}

function Harness({
  rows,
  isAdmin = false,
  resetKey = "k1",
}: {
  rows: Row[];
  isAdmin?: boolean;
  resetKey?: string;
}) {
  const groupsByKey: Record<string, GroupInfo> = {};
  for (const r of rows) {
    groupsByKey[r.key] = { ids: r.ids, status: r.status, patientActive: r.patientActive ?? true };
  }
  const entries: SelectionEntry[] = rows.map((r) => ({
    rowKey: r.key,
    kinds: [r.status],
    weight: r.ids.length,
  }));
  return (
    <SelectionProvider resetKey={resetKey}>
      <table>
        <thead>
          <tr>
            <th>
              <SelectAllCheckbox entries={entries} label="Select all bookings" />
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>
                <RowSelectCheckbox rowKey={r.key} kinds={[r.status]} weight={r.ids.length} label={r.key} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <AppointmentsBulkBar groupsByKey={groupsByKey} isAdmin={isAdmin} />
    </SelectionProvider>
  );
}

beforeEach(() => {
  vi.mocked(bulkTransitionAction).mockReset();
  vi.mocked(bulkDeleteAction).mockReset();
  router.refresh.mockReset();
  // BulkBar measures its own height with a ResizeObserver — not implemented
  // in jsdom.
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  vi.spyOn(window, "alert").mockImplementation(() => {});
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(cleanup);

describe("selecting rows", () => {
  it("shows the bar with the count and only the buttons the row's status allows", async () => {
    const user = userEvent.setup();
    render(<Harness rows={[{ key: "g1", ids: ["a1"], status: "confirmed" }]} />);

    await user.click(screen.getByRole("checkbox", { name: "Select g1" }));

    expect(screen.getByText("1", { selector: "span" })).toBeTruthy();
    expect(screen.getByText("booking selected", { exact: false })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mark arrived (1)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "No-show (1)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel (1)" })).toBeTruthy();
    // confirmed bookings are not eligible for Confirm or Revert, and Delete
    // is admin-only.
    expect(screen.queryByRole("button", { name: /^Confirm/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Revert/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Delete/ })).toBeNull();
  });

  it("select-all ticks every row, and clicking it again clears them", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        rows={[
          { key: "g1", ids: ["a1"], status: "confirmed" },
          { key: "g2", ids: ["a2"], status: "confirmed" },
        ]}
      />,
    );

    await user.click(screen.getByRole("checkbox", { name: "Select all bookings" }));
    expect((screen.getByRole("checkbox", { name: "Select g1" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Select g2" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("button", { name: "Cancel (2)" })).toBeTruthy();

    await user.click(screen.getByRole("checkbox", { name: "Select all bookings" }));
    expect((screen.getByRole("checkbox", { name: "Select g1" }) as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByRole("region", { name: "Selected rows" })).toBeNull();
  });
});

it("a filter/list change (resetKey) drops the selection without being told to", async () => {
  const user = userEvent.setup();
  const rows: Row[] = [{ key: "g1", ids: ["a1"], status: "confirmed" }];
  const { rerender } = render(<Harness rows={rows} resetKey="type=all" />);
  await user.click(screen.getByRole("checkbox", { name: "Select g1" }));
  expect(screen.getByRole("button", { name: "Cancel (1)" })).toBeTruthy();

  rerender(<Harness rows={rows} resetKey="type=pending" />); // e.g. the filter tab changed

  expect((screen.getByRole("checkbox", { name: "Select g1" }) as HTMLInputElement).checked).toBe(false);
  expect(screen.queryByRole("region", { name: "Selected rows" })).toBeNull();
});

describe("running a bulk action", () => {
  it("sends exactly the selected ids and the expected status, then clears the selection on a clean success", async () => {
    vi.mocked(bulkTransitionAction).mockResolvedValue({ ok: true, changedIds: ["a1", "a2", "a3"] });
    const user = userEvent.setup();
    render(
      <Harness
        rows={[
          { key: "g1", ids: ["a1"], status: "confirmed" },
          { key: "g2", ids: ["a2", "a3"], status: "confirmed" },
        ]}
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Select all bookings" }));
    await user.click(screen.getByRole("button", { name: "Mark arrived (2)" }));

    expect(bulkTransitionAction).toHaveBeenCalledTimes(1);
    const [batch, to] = vi.mocked(bulkTransitionAction).mock.calls[0]!;
    expect(batch).toEqual([
      { ids: ["a1"], from: "confirmed" },
      { ids: ["a2", "a3"], from: "confirmed" },
    ]);
    expect(to).toBe("arrived");
    expect(window.alert).not.toHaveBeenCalled(); // every booking changed — nothing to explain
    expect(screen.queryByRole("region", { name: "Selected rows" })).toBeNull();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("asks for confirmation on a destructive action, and sends nothing if it's cancelled", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    const user = userEvent.setup();
    render(<Harness rows={[{ key: "g1", ids: ["a1"], status: "confirmed" }]} />);
    await user.click(screen.getByRole("checkbox", { name: "Select g1" }));
    await user.click(screen.getByRole("button", { name: "Cancel (1)" }));

    expect(window.confirm).toHaveBeenCalled();
    expect(bulkTransitionAction).not.toHaveBeenCalled();
    // Nothing was sent, so the selection is exactly as the operator left it.
    expect(screen.getByRole("button", { name: "Cancel (1)" })).toBeTruthy();
  });

  it("a partial result is reported to the operator, but every sent row is still pruned (the alert is the record)", async () => {
    vi.mocked(bulkTransitionAction).mockResolvedValue({ ok: true, changedIds: ["a1"] }); // g2 didn't move
    const user = userEvent.setup();
    render(
      <Harness
        rows={[
          { key: "g1", ids: ["a1"], status: "confirmed" },
          { key: "g2", ids: ["a2"], status: "confirmed" },
        ]}
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Select all bookings" }));
    await user.click(screen.getByRole("button", { name: "Mark arrived (2)" }));

    const outcome = summariseOutcome(
      ["g1", "g2"],
      { g1: { ids: ["a1"], status: "confirmed", patientActive: true }, g2: { ids: ["a2"], status: "confirmed", patientActive: true } },
      ["a1"],
    );
    const expected = outcomeMessage("Marked", "arrived", outcome);
    expect(window.alert).toHaveBeenCalledWith(expected);
    expect(screen.queryByRole("region", { name: "Selected rows" })).toBeNull();
  });

  it("a refused batch shows the error and keeps the selection so the operator can retry", async () => {
    vi.mocked(bulkTransitionAction).mockResolvedValue({ ok: false, error: "Reception or admin only." });
    const user = userEvent.setup();
    render(<Harness rows={[{ key: "g1", ids: ["a1"], status: "confirmed" }]} />);
    await user.click(screen.getByRole("checkbox", { name: "Select g1" }));
    await user.click(screen.getByRole("button", { name: "Mark arrived (1)" }));

    expect(window.alert).toHaveBeenCalledWith("Reception or admin only.");
    expect(screen.getByRole("button", { name: "Cancel (1)" })).toBeTruthy();
    expect(router.refresh).toHaveBeenCalled(); // a partial write can still have committed some rows
  });

  it("Delete only appears for an admin, and calls the delete action rather than a transition", async () => {
    const user = userEvent.setup();
    const rows: Row[] = [{ key: "g1", ids: ["a1"], status: "confirmed" }];
    const { rerender } = render(<Harness rows={rows} isAdmin={false} />);
    await user.click(screen.getByRole("checkbox", { name: "Select g1" }));
    expect(screen.queryByRole("button", { name: /^Delete/ })).toBeNull();

    rerender(<Harness rows={rows} isAdmin={true} />);
    vi.mocked(bulkDeleteAction).mockResolvedValue({ ok: true, changedIds: ["a1"] });
    await user.click(screen.getByRole("button", { name: "Delete (1)" }));

    expect(bulkDeleteAction).toHaveBeenCalledWith([{ ids: ["a1"], from: "confirmed" }]);
    expect(bulkTransitionAction).not.toHaveBeenCalled();
  });
});

it("skips inactive-patient rows for the buttons that need one, and says how many", async () => {
  const user = userEvent.setup();
  render(
    <Harness
      rows={[
        { key: "g1", ids: ["a1"], status: "confirmed", patientActive: false },
        { key: "g2", ids: ["a2"], status: "confirmed", patientActive: true },
      ]}
    />,
  );
  await user.click(screen.getByRole("checkbox", { name: "Select all bookings" }));

  expect(
    screen.getByText("1 skipped for Mark arrived, Confirm and Revert — patient record deleted or merged"),
  ).toBeTruthy();
  // "arrive" needs an active patient, so only g2 is offered it; "cancel" doesn't.
  expect(screen.getByRole("button", { name: "Mark arrived (1)" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Cancel (2)" })).toBeTruthy();
});
