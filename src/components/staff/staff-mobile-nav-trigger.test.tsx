import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The mobile drawer duplicates the desktop sidebar's section markup, so it
// gets its own assertions — a bug in one wouldn't show up in the other.
// Three stubs make it renderable without a DOM: the pathname hook, the
// portal-based drawer (always render its children so the nav is in the
// output), and the sign-out Server Action.
const pathname = vi.hoisted(() => ({ current: "/staff" }));
vi.mock("next/navigation", () => ({
  usePathname: () => pathname.current,
}));
vi.mock("@/components/ui/mobile-drawer", () => ({
  MobileDrawer: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  HamburgerIcon: () => <svg />,
  CloseIcon: () => <svg />,
}));
vi.mock("@/app/(staff)/staff/login/actions", () => ({
  signOutStaff: "/noop",
}));

const { StaffMobileNavTrigger } = await import("./staff-mobile-nav-trigger");

function render(
  role: Parameters<typeof StaffMobileNavTrigger>[0]["role"],
  path: string,
) {
  pathname.current = path;
  return renderToStaticMarkup(
    <StaffMobileNavTrigger role={role} email="a@b.ph" fullName="Test Staff" />,
  );
}

// <details open> serializes as `<details open="" …>`; a collapsed one carries
// no `open` attribute. Return the opening tag of the section owning `href`,
// and test it with isOpen() rather than a bare substring check — a class name
// containing "open" would otherwise read as an expanded section.
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
    const end = html.indexOf("</details>", close);
    if (end !== -1 && html.slice(close, end).includes(`href="${href}"`)) {
      last = html.slice(open, close + 1);
    }
    from = close + 1;
  }
  return last;
}

beforeEach(() => {
  pathname.current = "/staff";
});

describe("mobile drawer — Hidden Tabs (partner revision 8)", () => {
  it("is a collapsed <details> for admin", () => {
    const html = render("admin", "/staff");
    expect(html).toContain("Hidden Tabs");
    const tag = detailsTagContaining(html, "/staff/registration");
    expect(tag).not.toBeNull();
    expect(isOpen(tag)).toBe(false);
  });

  it("auto-expands when the admin is inside it", () => {
    const html = render("admin", "/staff/gift-codes/sell");
    expect(isOpen(detailsTagContaining(html, "/staff/gift-codes/sell"))).toBe(
      true,
    );
  });

  it("is absent for reception", () => {
    const html = render("reception", "/staff");
    expect(html).not.toContain("Hidden Tabs");
    expect(html).not.toContain('href="/staff/registration"');
  });
});

describe("mobile drawer — My payslips", () => {
  it.each(["reception", "medtech", "pathologist", "admin", "xray_technician"] as const)(
    "%s gets a My payslips link outside any collapsed section",
    (role) => {
      const html = render(role, "/staff");
      expect(html).toContain('href="/staff/payslips"');
      expect(detailsTagContaining(html, "/staff/payslips")).toBeNull();
    },
  );
});

// ---------------------------------------------------------------------------
// Sidebar cleanup (2026-09-15) — the drawer mirrors the desktop sidebar, so it
// gets the same assertions.
// ---------------------------------------------------------------------------

function ariaCurrentHrefs(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*>/g)]
    .filter((m) => /aria-current="page"/.test(m[0]))
    .map((m) => m[0].match(/href="([^"]*)"/)![1]);
}

describe("mobile drawer — Inquiries & Bookings subgroup", () => {
  it("is a collapsed <details> under Front Desk for reception", () => {
    const html = render("reception", "/staff");
    expect(html).toContain("Inquiries &amp; Bookings");
    const tag = detailsTagContaining(html, "/staff/appointments");
    expect(tag).not.toBeNull();
    expect(isOpen(tag)).toBe(false);
    expect(html.indexOf('href="/staff/appointments"')).toBeLessThan(
      html.indexOf('href="/staff/inquiries"'),
    );
  });

  it("auto-expands when reception is on Inquiries", () => {
    const html = render("reception", "/staff/inquiries");
    expect(isOpen(detailsTagContaining(html, "/staff/inquiries"))).toBe(true);
  });
});

describe("mobile drawer — labels and aria-current", () => {
  it("shows the Title Case labels and none of the retired items", () => {
    const html = render("reception", "/staff");
    for (const label of ["Visit Records", "Quick Quote", "Cash Drawer", "Front Desk"]) {
      expect(html).toContain(label);
    }
    expect(html).not.toContain("Visit archive");
    expect(html).not.toContain('href="/staff/patients/new"');
    expect(html).not.toContain('href="/staff/payments/petty-cash"');
  });

  it("marks the active link with aria-current=page", () => {
    expect(ariaCurrentHrefs(render("reception", "/staff/payments/eod"))).toEqual([
      "/staff/payments/cash-drawer",
    ]);
    expect(ariaCurrentHrefs(render("reception", "/staff/patients/new"))).toEqual([
      "/staff/patients",
    ]);
  });
});
