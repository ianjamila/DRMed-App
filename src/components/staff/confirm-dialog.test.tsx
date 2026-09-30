// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfirmDialog } from "./confirm-dialog";

vi.mock("@/lib/a11y/use-focus-trap", () => ({ useFocusTrap: () => ({ current: null }) }));

const base = {
  open: true,
  title: "Delete DRM-0001?",
  body: <p>body</p>,
  confirmLabel: "Delete patient",
  confirmVariant: "danger" as const,
  onConfirm: () => {},
  onCancel: () => {},
};

const confirmButton = (html: string) => {
  const m = /<button[^>]*>Delete patient<\/button>/.exec(html);
  return m ? m[0] : "";
};

// Match the actual `disabled=""` HTML attribute, not the always-present
// Tailwind `disabled:opacity-50` class name (a plain /disabled/ match is a
// false positive on every render, enabled or not).
const DISABLED_ATTR = /\sdisabled=""/;
const ARIA_DISABLED = /\saria-disabled="true"/;

afterEach(cleanup);

describe("ConfirmDialog", () => {
  it("enables confirm by default", () => {
    const html = confirmButton(renderToStaticMarkup(<ConfirmDialog {...base} />));
    expect(html).not.toMatch(DISABLED_ATTR);
    expect(html).not.toMatch(ARIA_DISABLED);
  });
  it("blocks confirm with aria-disabled, not native disabled, when confirmDisabled", () => {
    const html = confirmButton(renderToStaticMarkup(<ConfirmDialog {...base} confirmDisabled />));
    expect(html).toMatch(ARIA_DISABLED);
    expect(html).not.toMatch(DISABLED_ATTR);
  });
  it("blocks confirm with aria-disabled while a required reason is empty", () => {
    const html = confirmButton(renderToStaticMarkup(<ConfirmDialog {...base} reasonRequired reasonValue="  " />));
    expect(html).toMatch(ARIA_DISABLED);
    expect(html).not.toMatch(DISABLED_ATTR);
  });
  it("uses native disabled only while the action is in flight", () => {
    const html = /<button[^>]*>Working\.\.\.<\/button>/.exec(renderToStaticMarkup(<ConfirmDialog {...base} isPending />))?.[0] ?? "";
    expect(html).toMatch(DISABLED_ATTR);
  });
  it("a blocked confirm stays reachable by Tab and announces why, but ignores clicks", async () => {
    const onConfirm = vi.fn();
    render(
      <>
        <p id="why">Open appointment on 2 Oct</p>
        <ConfirmDialog {...base} onConfirm={onConfirm} confirmDisabled confirmDescribedBy="why" />
      </>,
    );
    const user = userEvent.setup();
    const confirm = screen.getByRole("button", { name: "Delete patient" });
    await user.tab();
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(confirm);
    expect(document.getElementById(confirm.getAttribute("aria-describedby") ?? "")?.textContent).toBe("Open appointment on 2 Oct");
    await user.click(confirm);
    await user.keyboard("{Enter}");
    expect(onConfirm).not.toHaveBeenCalled();
  });
  it("an unblocked confirm calls onConfirm", async () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog {...base} onConfirm={onConfirm} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Delete patient" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
  it("renders nothing when closed", () => {
    expect(renderToStaticMarkup(<ConfirmDialog {...base} open={false} />)).toBe("");
  });
  it("announces confirmDescribedBy on the confirm button", () => {
    const html = confirmButton(renderToStaticMarkup(<ConfirmDialog {...base} confirmDescribedBy="blockers-1" />));
    expect(html).toMatch(/aria-describedby="blockers-1"/);
  });
  it("omits aria-describedby when confirmDescribedBy is not set", () => {
    const html = confirmButton(renderToStaticMarkup(<ConfirmDialog {...base} />));
    expect(html).not.toMatch(/aria-describedby/);
  });
});
