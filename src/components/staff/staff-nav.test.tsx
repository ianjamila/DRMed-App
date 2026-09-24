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

function render(
  role: Parameters<typeof StaffNav>[0]["role"],
  path: string,
  badges?: Record<string, number>,
) {
  pathname.current = path;
  return renderToStaticMarkup(<StaffNav role={role} badges={badges} />);
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

describe("Messages & Bookings section (above Front Desk, 2026-09-24)", () => {
  it("renders as a plain, always-open section before Front Desk", () => {
    const html = render("reception", "/staff");
    expect(html).toContain("Messages &amp; Bookings");
    expect(detailsTagContaining(html, "/staff/appointments")).toBeNull();
    expect(detailsTagContaining(html, "/staff/messages")).toBeNull();
    expect(html.indexOf("Messages &amp; Bookings")).toBeLessThan(html.indexOf("Front Desk"));
  });

  it("lists Appointments before Website Messages", () => {
    const html = render("reception", "/staff");
    expect(html.indexOf('href="/staff/appointments"')).toBeLessThan(
      html.indexOf('href="/staff/messages"'),
    );
  });

  it("marks Appointments and a nested Messages route as the current page", () => {
    expect(ariaCurrentHrefs(render("reception", "/staff/appointments"))).toEqual(["/staff/appointments"]);
    expect(ariaCurrentHrefs(render("admin", "/staff/messages/abc-123"))).toEqual(["/staff/messages"]);
  });

  it("holds Quick Quote, then Patients and Reception Queue below it, flat, followed by the old Billing items", () => {
    const html = render("reception", "/staff");
    expect(detailsTagContaining(html, "/staff/visits/queue")).toBeNull();
    expect(detailsTagContaining(html, "/staff/patients")).toBeNull();
    const order = ['href="/staff/appointments"', 'href="/staff/messages"', 'href="/staff/quote"', 'href="/staff/patients"', 'href="/staff/visits/queue"', 'href="/staff/visits"', 'href="/staff/payments/cash-drawer"'].map((h) => html.indexOf(h));
    expect(order.every((pos) => pos > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).not.toMatch(/>Billing</);
  });
});

describe("Front Desk divider", () => {
  it("draws one hidden rule between Reception Queue and Visit Records", () => {
    const html = render("reception", "/staff");
    const dividers = [...html.matchAll(/data-nav-divider=""/g)].map((m) => m.index!);
    expect(dividers).toHaveLength(1);
    expect(html.indexOf('href="/staff/visits/queue"')).toBeLessThan(dividers[0]);
    expect(dividers[0]).toBeLessThan(html.indexOf('href="/staff/visits"'));
    expect(html).toMatch(/<li aria-hidden="true" data-nav-divider=""/);
  });
});

describe("Admin subgroup dividers", () => {
  const dividerCount = (html: string) => html.match(/data-nav-divider=""/g)?.length ?? 0;

  it("admin gets the Front Desk rule plus the seven Admin subgroup rules", () => {
    expect(dividerCount(render("admin", "/staff"))).toBe(8);
  });

  it("puts the Books & Reports rule between Recurring Monthly Entries and Daily Monitoring", () => {
    const html = render("admin", "/staff/admin/accounting/journal");
    const before = html.indexOf('href="/staff/admin/accounting/accrual-templates"');
    const after = html.indexOf('href="/staff/admin/operations"');
    const rule = html.indexOf('data-nav-divider=""', before);
    expect(before).toBeGreaterThan(-1);
    expect(rule).toBeGreaterThan(before);
    expect(rule).toBeLessThan(after);
  });

  it("medtech (Inventory only under Operations) sees no rules at all", () => {
    expect(dividerCount(render("medtech", "/staff"))).toBe(0);
  });
});

describe("nav count badges", () => {
  it("renders the pill with the count for an item with a badge", () => {
    const html = render("reception", "/staff", { "/staff/messages": 3 });
    expect(html).toMatch(/<span aria-hidden="true">3<\/span>/);
    expect(html).toContain("3 new");
  });

  it("renders no pill when the count is 0 or the item has no entry", () => {
    const html = render("reception", "/staff", { "/staff/messages": 0 });
    expect(html).not.toMatch(/aria-hidden="true">\d/);
    const htmlNoBadges = render("reception", "/staff");
    expect(htmlNoBadges).not.toMatch(/aria-hidden="true">\d/);
  });

  it("caps the display at 99+ for a large count", () => {
    const html = render("reception", "/staff", { "/staff/messages": 150 });
    expect(html).toMatch(/<span aria-hidden="true">99\+<\/span>/);
  });

  it("shows the Website Messages count once, on the always-visible link", () => {
    const html = render("reception", "/staff", { "/staff/messages": 5 });
    expect(detailsTagContaining(html, "/staff/messages")).toBeNull();
    expect(html.match(/5 new/g)).toHaveLength(1);
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

  it("medtech sees Lab & Imaging but no Quick Quote, Front Desk or Messages & Bookings", () => {
    const html = render("medtech", "/staff");
    expect(html).toContain("Lab &amp; Imaging");
    expect(html).not.toContain('href="/staff/quote"');
    expect(html).not.toContain("Front Desk");
    expect(html).not.toContain("Messages &amp; Bookings");
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
