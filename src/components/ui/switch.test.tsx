import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Switch } from "./switch";

// Client component with no browser dependency beyond the click handler, so
// the real markup renders with renderToStaticMarkup — no DOM needed (same
// style as staff-nav.test.tsx).
describe("Switch", () => {
  it("is a real <button> with role=switch and aria-checked reflecting state", () => {
    const on = renderToStaticMarkup(
      <Switch checked={true} onCheckedChange={() => {}} aria-label="Test alert" />,
    );
    expect(on).toMatch(/^<button/);
    expect(on).toContain('role="switch"');
    expect(on).toContain('aria-checked="true"');

    const off = renderToStaticMarkup(
      <Switch checked={false} onCheckedChange={() => {}} aria-label="Test alert" />,
    );
    expect(off).toContain('aria-checked="false"');
  });

  it("carries the caller's accessible label", () => {
    const html = renderToStaticMarkup(
      <Switch checked={false} onCheckedChange={() => {}} aria-label="Pause website message alerts" />,
    );
    expect(html).toContain('aria-label="Pause website message alerts"');
  });

  it("is disabled while saving", () => {
    const html = renderToStaticMarkup(
      <Switch checked={false} onCheckedChange={() => {}} disabled aria-label="Test alert" />,
    );
    expect(html).toContain('disabled=""');
  });

  it("moves the thumb between the off and on positions", () => {
    const off = renderToStaticMarkup(
      <Switch checked={false} onCheckedChange={() => {}} aria-label="Test alert" />,
    );
    const on = renderToStaticMarkup(
      <Switch checked={true} onCheckedChange={() => {}} aria-label="Test alert" />,
    );
    expect(off).not.toContain("translate-x-5");
    expect(on).toContain("translate-x-5");
  });
});
