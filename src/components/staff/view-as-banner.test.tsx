// src/components/staff/view-as-banner.test.tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Client components rendered without a DOM: stub the router and the two
// Server Actions (a string action serialises as a plain form action).
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
}));
vi.mock("@/app/(staff)/staff/(dashboard)/view-as/actions", () => ({
  startViewAsAction: "/noop-start",
  exitViewAsAction: "/noop-exit",
}));

const { ViewAsBanner } = await import("./view-as-banner");
const { ViewAsSelect } = await import("./view-as-select");

describe("ViewAsBanner", () => {
  const html = renderToStaticMarkup(
    <ViewAsBanner role="reception" until="2026-09-25T08:00:00.000Z" remainingLabel="3h 40m" />,
  );
  it("names the role, warns about saves, and shows the remaining time", () => {
    expect(html).toContain("Viewing as Reception.");
    expect(html).toContain("Anything you save is recorded under your name.");
    expect(html).toContain("Ends in 3h 40m.");
  });
  it("is a status region hidden on print, with Exit and a role select", () => {
    expect(html).toContain('role="status"');
    expect(html).toContain("print:hidden");
    expect(html).toContain('action="/noop-exit"');
    expect(html).toContain(">Exit<");
    expect(html).toContain('action="/noop-start"');
    expect(html).toContain('name="role"');
  });
});

describe("ViewAsSelect", () => {
  it("lists exactly the four non-admin roles with the current one selected", () => {
    const html = renderToStaticMarkup(<ViewAsSelect current="medtech" id="t" />);
    expect(html).toContain('<option value="reception">Reception</option>');
    // Attribute order (value vs selected) is a React internal, not load-bearing.
    expect(html).toContain('value="medtech"');
    expect(html).toContain('selected=""');
    expect(html).toContain(">Medical Tech</option>");
    expect(html).toContain('<option value="xray_technician">X-ray Technician</option>');
    expect(html).toContain('<option value="pathologist">Pathologist</option>');
    expect(html).not.toContain('value="admin"');
  });
  it("with no current role shows the placeholder selected", () => {
    const html = renderToStaticMarkup(<ViewAsSelect current={null} id="t" />);
    expect(html).toContain('value=""');
    expect(html).toContain("View as…");
    expect(html).toContain('selected=""');
  });
});
