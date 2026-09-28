// src/components/staff/view-as-banner.test.tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Client components rendered without a DOM: stub the router and the two
// Server Actions (a string action serialises as a plain form action).
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
  usePathname: () => "/staff",
}));
vi.mock("@/app/(staff)/staff/(dashboard)/view-as/actions", () => ({
  startViewAsAction: async () => ({ error: null }),
  exitViewAsAction: async () => ({ error: null }),
}));

const { ViewAsBanner } = await import("./view-as-banner");
const { ViewAsSelect } = await import("./view-as-select");

describe("ViewAsBanner", () => {
  const html = renderToStaticMarkup(
    <ViewAsBanner
      role="reception"
      until="2026-09-25T08:00:00.000Z"
      untilLabel="4:00 PM"
      remainingMs={3 * 3_600_000 + 40 * 60_000}
    />,
  );
  it("names the role, the absolute end time and the time left, and warns about saves", () => {
    expect(html).toContain("Viewing as Reception");
    expect(html).toContain("until 4:00 PM");
    expect(html).toContain("3h 40m left");
    expect(html).toContain("Anything you save is recorded under your name.");
  });
  it("is a status region hidden on print, with Exit and a role select", () => {
    expect(html).toContain('role="status"');
    expect(html).toContain("print:hidden");
    expect(html).toContain(">Exit<");
    expect(html).toContain('name="role"');
  });
  it("first render uses the server's remainingMs, not the device clock", () => {
    // Tick-by-tick countdown behaviour (a matching vs. a stale tick) is
    // covered by the pure countdownRemainingMs unit tests in view-as.test.ts —
    // effects (and thus the interval) never run under renderToStaticMarkup.
    const skewed = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2030-01-01T00:00:00Z"));
    const h = renderToStaticMarkup(
      <ViewAsBanner role="medtech" until="2026-09-25T08:00:00.000Z" untilLabel="4:00 PM" remainingMs={12 * 60_000} />,
    );
    expect(h).toContain("12m left");
    skewed.mockRestore();
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
  it("carries a hidden return_to field and no error by default", () => {
    const html = renderToStaticMarkup(<ViewAsSelect current={null} id="t" />);
    expect(html).toContain('type="hidden"');
    expect(html).toContain('name="return_to"');
    expect(html).not.toContain('role="alert"');
  });
});

const { ViewAsExitButton } = await import("./view-as-exit-button");
describe("ViewAsExitButton", () => {
  it("renders an Exit submit with a hidden return_to", () => {
    const html = renderToStaticMarkup(<ViewAsExitButton />);
    expect(html).toContain(">Exit<");
    expect(html).toContain('name="return_to"');
  });
});
