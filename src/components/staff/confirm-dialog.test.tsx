import { describe, expect, it, vi } from "vitest";
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

describe("ConfirmDialog", () => {
  it("enables confirm by default", () => {
    expect(confirmButton(renderToStaticMarkup(<ConfirmDialog {...base} />))).not.toMatch(DISABLED_ATTR);
  });
  it("disables confirm when confirmDisabled", () => {
    expect(confirmButton(renderToStaticMarkup(<ConfirmDialog {...base} confirmDisabled />))).toMatch(DISABLED_ATTR);
  });
  it("renders nothing when closed", () => {
    expect(renderToStaticMarkup(<ConfirmDialog {...base} open={false} />)).toBe("");
  });
});
