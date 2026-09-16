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

describe("Hidden Tabs section (partner revision 8)", () => {
  it("renders for admin as a <details> that is collapsed by default", () => {
    const html = render("admin", "/staff");
    expect(html).toContain("Hidden Tabs");
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
    expect(html).not.toContain("Hidden Tabs");
    expect(html).not.toContain('href="/staff/registration"');
    expect(html).not.toContain('href="/staff/gift-codes/sell"');
  });

  it("is absent entirely for the pathologist, including Sign-off", () => {
    const html = render("pathologist", "/staff");
    expect(html).not.toContain("Hidden Tabs");
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
  it("still renders Front Desk as a flat heading + list", () => {
    const html = render("reception", "/staff");
    expect(html).toContain("Front Desk");
    expect(html).toContain('href="/staff/payments/cash-drawer"');
    expect(detailsTagContaining(html, "/staff/payments/cash-drawer")).toBeNull();
  });

  it("keeps admin subgroups collapsible and auto-expanding", () => {
    const html = render("admin", "/staff/admin/payroll/runs");
    const tag = detailsTagContaining(html, "/staff/admin/payroll/runs");
    expect(isOpen(tag)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sidebar cleanup (2026-09-15).
// ---------------------------------------------------------------------------

// The opening <a …> tag of the nav link pointing at `href`, or null.
function linkTagFor(html: string, href: string): string | null {
  const m = html.match(new RegExp(`<a\\b[^>]*href="${href}"[^>]*>`));
  return m ? m[0] : null;
}

function ariaCurrentHrefs(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*>/g)]
    .filter((m) => /aria-current="page"/.test(m[0]))
    .map((m) => m[0].match(/href="([^"]*)"/)![1]);
}

describe("Inquiries & Bookings subgroup (sidebar cleanup)", () => {
  it("renders inside Front Desk as a <details> collapsed by default", () => {
    const html = render("reception", "/staff");
    expect(html).toContain("Inquiries &amp; Bookings");
    const tag = detailsTagContaining(html, "/staff/appointments");
    expect(tag).not.toBeNull();
    expect(isOpen(tag)).toBe(false);
    expect(detailsTagContaining(html, "/staff/inquiries")).toBe(tag);
  });

  it("lists Appointments before Inquiries", () => {
    const html = render("reception", "/staff");
    expect(html.indexOf('href="/staff/appointments"')).toBeLessThan(
      html.indexOf('href="/staff/inquiries"'),
    );
  });

  it("auto-expands on Appointments and on a nested Inquiries route", () => {
    expect(
      isOpen(detailsTagContaining(render("reception", "/staff/appointments"), "/staff/appointments")),
    ).toBe(true);
    expect(
      isOpen(detailsTagContaining(render("admin", "/staff/inquiries/abc-123"), "/staff/inquiries")),
    ).toBe(true);
  });

  it("keeps Reception Queue and Patients as flat links above it", () => {
    const html = render("reception", "/staff");
    expect(detailsTagContaining(html, "/staff/visits/queue")).toBeNull();
    expect(detailsTagContaining(html, "/staff/patients")).toBeNull();
    expect(html.indexOf('href="/staff/patients"')).toBeLessThan(
      html.indexOf("Inquiries &amp; Bookings"),
    );
  });
});

describe("visible labels (sidebar cleanup)", () => {
  it("reception sees the new Title Case labels and none of the retired items", () => {
    const html = render("reception", "/staff");
    for (const label of ["Reception Queue", "Visit Records", "Quick Quote", "Cash Drawer", "Front Desk"]) {
      expect(html).toContain(label);
    }
    for (const gone of [
      "Visit archive",
      "Petty cash",
      "New patient registration",
      'href="/staff/patients/new"',
      'href="/staff/payments/petty-cash"',
    ]) {
      expect(html).not.toContain(gone);
    }
  });

  it("medtech sees Lab & Imaging and Quick Quote but no Front Desk", () => {
    const html = render("medtech", "/staff");
    expect(html).toContain("Lab &amp; Imaging");
    expect(html).toContain('href="/staff/quote"');
    expect(html).not.toContain("Front Desk");
  });
});

describe("aria-current (sidebar cleanup)", () => {
  it("marks exactly the active link, matching SectionTabs", () => {
    const html = render("reception", "/staff/patients/new");
    expect(ariaCurrentHrefs(html)).toEqual(["/staff/patients"]);
    expect(linkTagFor(html, "/staff/patients")).toMatch(/aria-current="page"/);
  });

  it("follows Cash Drawer onto the Petty Cash tab", () => {
    expect(ariaCurrentHrefs(render("reception", "/staff/payments/petty-cash"))).toEqual([
      "/staff/payments/cash-drawer",
    ]);
  });

  it("marks nothing on Record payment", () => {
    expect(ariaCurrentHrefs(render("reception", "/staff/payments/new"))).toEqual([]);
  });
});
