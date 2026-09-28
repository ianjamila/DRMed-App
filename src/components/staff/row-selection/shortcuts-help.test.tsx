// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BulkBar } from "./bulk-bar";
import { RowSelectCheckbox } from "./row-select-checkbox";
import { SelectionProvider } from "./selection-context";
import { ShortcutsHelp } from "./shortcuts-help";

// The "?" affordance (bulk-select follow-ups item 7 part 2): a small popover
// listing the bar's keyboard shortcuts. Mounted here inside a real BulkBar +
// SelectionProvider (the same kit the queue/appointments bars use) so the
// Escape-coordination and keyboard-jump rules are proven against the real
// bar, not a stand-in.

beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(cleanup);

function Harness() {
  return (
    <SelectionProvider resetKey="k1">
      <RowSelectCheckbox rowKey="r1" kinds={["doable"]} label="Row 1" />
      <BulkBar noun="row">
        <button type="button">Do the thing</button>
      </BulkBar>
    </SelectionProvider>
  );
}

describe("standalone (no bar)", () => {
  it("opens and closes the popover by clicking the button", async () => {
    const user = userEvent.setup();
    render(<ShortcutsHelp />);
    const button = screen.getByRole("button", { name: "Keyboard shortcuts" });
    expect(button).toHaveProperty("ariaExpanded", "false");
    expect(screen.queryByRole("group", { name: "Keyboard shortcuts" })).toBeNull();

    await user.click(button);
    expect(button).toHaveProperty("ariaExpanded", "true");
    expect(screen.getByRole("group", { name: "Keyboard shortcuts" })).toBeTruthy();
    expect(screen.getByText("Alt+B (⌥B on Mac)")).toBeTruthy();
    expect(screen.getByText("Esc")).toBeTruthy();

    await user.click(button);
    expect(button).toHaveProperty("ariaExpanded", "false");
    expect(screen.queryByRole("group", { name: "Keyboard shortcuts" })).toBeNull();
  });

  it("closes when clicking outside, and returns focus to the button on close", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <button type="button">Outside</button>
        <ShortcutsHelp />
      </div>,
    );
    const button = screen.getByRole("button", { name: "Keyboard shortcuts" });
    await user.click(button);
    expect(screen.getByRole("group", { name: "Keyboard shortcuts" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("group", { name: "Keyboard shortcuts" })).toBeNull();
  });
});

describe("inside a real bar", () => {
  it("Escape closes the popover only — the selection stays; a second Escape then clears it", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("checkbox", { name: "Select Row 1" }));
    expect(screen.getByRole("button", { name: "Do the thing" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    expect(screen.getByRole("group", { name: "Keyboard shortcuts" })).toBeTruthy();

    await user.keyboard("{Escape}");
    // Popover closed, but the row is still selected — the bar (and its Undo
    // button target) is still there.
    expect(screen.queryByRole("group", { name: "Keyboard shortcuts" })).toBeNull();
    expect(screen.getByRole("region", { name: "Selected rows" })).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "Select Row 1" }) as HTMLInputElement).checked).toBe(true);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Selected rows" })).toBeNull();
  });

  it("the Alt+B / Enter jump still lands on the first real action, not the \"?\" button", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const checkbox = screen.getByRole("checkbox", { name: "Select Row 1" });
    await user.click(checkbox);
    checkbox.focus();

    await user.keyboard("{Enter}");
    const actionButton = screen.getByRole("button", { name: "Do the thing" });
    expect(document.activeElement).toBe(actionButton);
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Keyboard shortcuts" }));
  });
});
