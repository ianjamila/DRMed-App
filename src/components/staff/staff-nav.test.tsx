import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// StaffNav is a client component whose only browser dependency is the
// pathname. Stubbing it lets us render the real markup with
// renderToStaticMarkup — no DOM, no router, no RSC.
const pathname = vi.hoisted(() => ({ current: "/staff" }));
vi.mock("next/navigation", () => ({
  usePathname: () => pathname.current,
}));

const { StaffNav } = await import("./staff-nav");

function render(role: Parameters<typeof StaffNav>[0]["role"], path: string) {
  pathname.current = path;
  return renderToStaticMarkup(<StaffNav role={role} />);
}

// <details open> serializes as `<details open=""...>`; a collapsed one has no
// `open` attribute at all. Grab just the opening tag of the section that owns
// the given link so we can tell the two apart. Callers test it with
// isOpen() rather than a bare substring check — a class name containing
// "open" would otherwise read as an expanded section.
function isOpen(detailsTag: string | null): boolean {
  return detailsTag !== null && /<details\b[^>]*\sopen(=|\s|>)/.test(detailsTag);
}

function detailsTagContaining(html: string, href: string): string | null {
  let from = 0;
  let last: string | null = null;
  for (;;) {
    const open = html.indexOf("<details", from);
    if (open === -1) break;
    const close = html.indexOf(">", open);
    const tag = html.slice(open, close + 1);
    const end = html.indexOf("</details>", close);
    if (end !== -1 && html.slice(close, end).includes(`href="${href}"`)) {
      last = tag;
    }
    from = close + 1;
  }
  return last;
}

beforeEach(() => {
  pathname.current = "/staff";
});

describe("Hidden tabs section (partner revision 8)", () => {
  it("renders for admin as a <details> that is collapsed by default", () => {
    const html = render("admin", "/staff");
    expect(html).toContain("Hidden tabs");
    const tag = detailsTagContaining(html, "/staff/registration");
    expect(tag).not.toBeNull();
    expect(isOpen(tag)).toBe(false);
  });

  it("auto-expands when the admin is on one of its pages", () => {
    const html = render("admin", "/staff/registration");
    const tag = detailsTagContaining(html, "/staff/registration");
    expect(isOpen(tag)).toBe(true);
  });

  it("auto-expands on a nested route inside one of its pages", () => {
    const html = render("admin", "/staff/signoff/some-test-id");
    const tag = detailsTagContaining(html, "/staff/signoff");
    expect(isOpen(tag)).toBe(true);
  });

  it("stays collapsed when the admin is elsewhere", () => {
    const html = render("admin", "/staff/visits/queue");
    const tag = detailsTagContaining(html, "/staff/registration");
    expect(isOpen(tag)).toBe(false);
  });

  it("is absent entirely for reception", () => {
    const html = render("reception", "/staff");
    expect(html).not.toContain("Hidden tabs");
    expect(html).not.toContain('href="/staff/registration"');
    expect(html).not.toContain('href="/staff/gift-codes/sell"');
  });

  it("is absent entirely for the pathologist, including Sign-off", () => {
    const html = render("pathologist", "/staff");
    expect(html).not.toContain("Hidden tabs");
    expect(html).not.toContain('href="/staff/signoff"');
  });
});

describe("My payslips stays reachable for every role", () => {
  it.each(["reception", "medtech", "pathologist", "admin", "xray_technician"] as const)(
    "%s gets a My payslips link outside any collapsed section",
    (role) => {
      const html = render(role, "/staff");
      expect(html).toContain('href="/staff/payslips"');
      // Personal is a plain section, so the link must not sit inside a <details>.
      expect(detailsTagContaining(html, "/staff/payslips")).toBeNull();
    },
  );
});

describe("plain sections are unchanged", () => {
  it("still renders Front desk as a flat heading + list", () => {
    const html = render("reception", "/staff");
    expect(html).toContain("Front desk");
    expect(html).toContain('href="/staff/payments/cash-drawer"');
    expect(detailsTagContaining(html, "/staff/payments/cash-drawer")).toBeNull();
  });

  it("keeps admin subgroups collapsible and auto-expanding", () => {
    const html = render("admin", "/staff/admin/payroll/runs");
    const tag = detailsTagContaining(html, "/staff/admin/payroll/runs");
    expect(isOpen(tag)).toBe(true);
  });
});
