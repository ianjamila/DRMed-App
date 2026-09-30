// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({
  updateMessageStatusManyAction: vi.fn(),
  undoMessageStatusManyAction: vi.fn(),
}));

import { undoMessageStatusManyAction, updateMessageStatusManyAction } from "./actions";
import { MessagesBulkBar, type MessageRowInfo } from "./messages-bulk-bar";
import { SelectionProvider } from "@/components/staff/row-selection/selection-context";
import { RowSelectCheckbox } from "@/components/staff/row-selection/row-select-checkbox";
import { UNDO_EXPIRED } from "@/lib/ui/bulk-undo";

const ROWS: Record<string, MessageRowInfo> = {
  m1: { label: "Ana Cruz", status: "new" },
  m2: { label: "Ben Diaz", status: "booked" },
  m3: { label: "Cy Ong", status: "closed" },
};

function Harness({ resetKey = "k" }: { resetKey?: string }) {
  return (
    <SelectionProvider resetKey={resetKey}>
      {Object.entries(ROWS).map(([key, r]) => (
        // RowSelectCheckbox prefixes "Select " to its label itself.
        <RowSelectCheckbox key={key} rowKey={key} kinds={[r.status]} label={r.label} />
      ))}
      <MessagesBulkBar rowsByKey={ROWS} />
    </SelectionProvider>
  );
}

beforeEach(() => {
  vi.mocked(updateMessageStatusManyAction).mockReset();
  vi.mocked(undoMessageStatusManyAction).mockReset();
  router.refresh.mockReset();
  // BulkBar measures its own height with a ResizeObserver — not implemented in jsdom.
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(cleanup);

describe("MessagesBulkBar", () => {
  it("shows only the buttons the selection allows, with eligible counts", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByLabelText("Select Ana Cruz"));
    await userEvent.click(screen.getByLabelText("Select Ben Diaz"));
    expect(screen.getByRole("button", { name: "Mark replied (1)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mark closed (2)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reopen (1)" })).toBeTruthy();
  });

  it("sends each eligible message with the status the operator saw, and names what was skipped", async () => {
    vi.mocked(updateMessageStatusManyAction).mockResolvedValue({
      ok: true, changedIds: ["m1"], skipped: [{ id: "m2", reason: "changed since you selected it — refresh to see its status" }], batchId: "b-1",
    });
    render(<Harness />);
    await userEvent.click(screen.getByLabelText("Select Ana Cruz"));
    await userEvent.click(screen.getByLabelText("Select Ben Diaz"));
    await userEvent.click(screen.getByRole("button", { name: "Mark closed (2)" }));
    expect(updateMessageStatusManyAction).toHaveBeenCalledWith({
      entries: [{ id: "m1", from: "new" }, { id: "m2", from: "booked" }],
      to: "closed",
    });
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Marked 1 of 2 messages closed.");
    expect(status.textContent).toContain("Ben Diaz: changed since you selected it");
    expect(screen.getByRole("button", { name: "↶ Undo" })).toBeTruthy();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("rows a button does not cover stay selected", async () => {
    vi.mocked(updateMessageStatusManyAction).mockResolvedValue({ ok: true, changedIds: ["m1"], skipped: [], batchId: "b-1" });
    render(<Harness />);
    await userEvent.click(screen.getByLabelText("Select Ana Cruz"));
    await userEvent.click(screen.getByLabelText("Select Cy Ong"));
    await userEvent.click(screen.getByRole("button", { name: "Mark replied (1)" }));
    expect((screen.getByLabelText("Select Cy Ong") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Select Ana Cruz") as HTMLInputElement).checked).toBe(false);
  });

  it("a refused call keeps the selection and alerts", async () => {
    vi.mocked(updateMessageStatusManyAction).mockResolvedValue({ ok: false, error: "nope" });
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    render(<Harness />);
    await userEvent.click(screen.getByLabelText("Select Ana Cruz"));
    await userEvent.click(screen.getByRole("button", { name: "Mark closed (1)" }));
    expect(alertSpy).toHaveBeenCalledWith("nope");
    expect((screen.getByLabelText("Select Ana Cruz") as HTMLInputElement).checked).toBe(true);
    alertSpy.mockRestore();
  });

  it("Undo names what came back and what did not; an expired Undo hides the button", async () => {
    vi.mocked(updateMessageStatusManyAction).mockResolvedValue({ ok: true, changedIds: ["m1", "m2"], skipped: [], batchId: "b-1" });
    vi.mocked(undoMessageStatusManyAction).mockResolvedValueOnce({
      ok: true, restoredIds: ["m1"], notRestored: [{ id: "m2", reason: "changed again since — refresh to see its status" }],
    });
    render(<Harness />);
    await userEvent.click(screen.getByLabelText("Select Ana Cruz"));
    await userEvent.click(screen.getByLabelText("Select Ben Diaz"));
    await userEvent.click(screen.getByRole("button", { name: "Mark closed (2)" }));
    await userEvent.click(await screen.findByRole("button", { name: "↶ Undo" }));
    expect(undoMessageStatusManyAction).toHaveBeenCalledWith({ batchId: "b-1" });
    const text = (await screen.findByRole("status")).textContent ?? "";
    expect(text).toContain("Undone — 1 message is back to what it was.");
    expect(text).toContain("Ben Diaz: changed again since");
    expect(screen.queryByRole("button", { name: "↶ Undo" })).toBeNull();
  });

  it("a refused Undo (expired) drops the Undo button", async () => {
    vi.mocked(updateMessageStatusManyAction).mockResolvedValue({ ok: true, changedIds: ["m1"], skipped: [], batchId: "b-1" });
    vi.mocked(undoMessageStatusManyAction).mockResolvedValueOnce({ ok: false, error: UNDO_EXPIRED });
    render(<Harness />);
    await userEvent.click(screen.getByLabelText("Select Ana Cruz"));
    await userEvent.click(screen.getByRole("button", { name: "Mark closed (1)" }));
    await userEvent.click(await screen.findByRole("button", { name: "↶ Undo" }));
    expect((await screen.findByRole("status")).textContent).toContain(UNDO_EXPIRED);
    expect(screen.queryByRole("button", { name: "↶ Undo" })).toBeNull();
  });

  it("a resetKey change drops the selection and the bar", async () => {
    const { rerender } = render(<Harness resetKey="a" />);
    await userEvent.click(screen.getByLabelText("Select Ana Cruz"));
    expect(screen.getByRole("region", { name: "Selected rows" })).toBeTruthy();
    rerender(<Harness resetKey="b" />);
    expect(screen.queryByRole("region", { name: "Selected rows" })).toBeNull();
  });
});
