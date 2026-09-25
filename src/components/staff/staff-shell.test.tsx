// src/components/staff/staff-shell.test.tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { StaffSession } from "@/lib/auth/require-staff";

// The shell is a server component whose children are client components with
// browser dependencies. Stub each at the module boundary so the real shell
// markup renders with renderToStaticMarkup — no DOM, no router, no RSC.
const pathname = vi.hoisted(() => ({ current: "/staff" }));
vi.mock("next/navigation", () => ({
  usePathname: () => pathname.current,
  useRouter: () => ({ refresh: () => {} }),
}));
vi.mock("@/components/ui/mobile-drawer", () => ({
  MobileDrawer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  HamburgerIcon: () => <svg />,
  CloseIcon: () => <svg />,
}));
vi.mock("@/app/(staff)/staff/login/actions", () => ({ signOutStaff: "/noop-signout" }));
vi.mock("@/app/(staff)/staff/(dashboard)/view-as/actions", () => ({
  startViewAsAction: "/noop-start",
  exitViewAsAction: "/noop-exit",
}));
vi.mock("./notification-bell", () => ({ NotificationBell: () => null }));
vi.mock("./staff-quote-shortcut", () => ({ StaffQuoteShortcut: () => null }));

const { StaffShell } = await import("./staff-shell");

function session(over: Partial<StaffSession>): StaffSession {
  return {
    user_id: "u1",
    email: "a@x.test",
    full_name: "Ada Admin",
    role: "admin",
    actual_role: "admin",
    view_as: null,
    ...over,
  };
}
const render = (s: StaffSession) =>
  renderToStaticMarkup(<StaffShell session={s}><p>page</p></StaffShell>);

describe("StaffShell view-as", () => {
  it("admin with no override: two View-as selects (sidebar + drawer), no banner", () => {
    const html = render(session({}));
    expect(html.match(/name="role"/g)).toHaveLength(2);
    expect(html).not.toContain('role="status"');
    expect(html).toContain("Admin · a@x.test");
  });

  it("non-admin: no View-as control anywhere", () => {
    const html = render(session({ role: "reception", actual_role: "reception" }));
    expect(html).not.toContain('name="role"');
    expect(html).not.toContain("View as");
  });

  it("admin viewing as reception: banner, reception nav, footer says viewing as", () => {
    const html = render(
      session({
        role: "reception",
        view_as: { role: "reception", until: new Date(Date.now() + 3_600_000).toISOString() },
      }),
    );
    expect(html).toContain("Viewing as Reception.");
    expect(html).toContain('action="/noop-exit"');
    expect(html).toContain("Reception (viewing as) · Admin");
    // Admin-only sidebar item must be gone; a reception item must be present.
    expect(html).not.toContain('href="/staff/users"');
    expect(html).toContain('href="/staff/queue"');
  });
});
