import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// EndRoleViewButton ("use client") imports endViewAsForAction from the
// "use server" actions.ts — mock it so this stays a pure markup render, no
// server action wiring or database calls.
vi.mock("./actions", () => ({
  endViewAsForAction: async () => ({ error: null, notice: null }),
}));

const { ActiveRoleViewsPanel } = await import("./active-role-views-panel");

describe("ActiveRoleViewsPanel", () => {
  const now = new Date("2026-09-28T04:00:00.000Z");
  const CURRENT_ADMIN = "admin-self";

  it("lists who is viewing as what, until when, and time left", () => {
    const html = renderToStaticMarkup(
      <ActiveRoleViewsPanel
        now={now}
        currentAdminId={CURRENT_ADMIN}
        views={[{ id: "a", full_name: "Ada Admin", role: "reception", until: "2026-09-28T07:40:00.000Z" }]}
      />,
    );
    expect(html).toContain("Active role views");
    expect(html).toContain("Ada Admin");
    expect(html).toContain("Reception");
    expect(html).toContain("3:40 PM"); // 07:40Z = 15:40 Manila
    expect(html).toContain("3h 40m left");
  });

  it("says so when nobody is viewing as another role", () => {
    const html = renderToStaticMarkup(
      <ActiveRoleViewsPanel now={now} views={[]} currentAdminId={CURRENT_ADMIN} />,
    );
    expect(html).toContain("No one is viewing the app as another role.");
  });

  it("renders 'End now' for another admin's active view", () => {
    const html = renderToStaticMarkup(
      <ActiveRoleViewsPanel
        now={now}
        currentAdminId={CURRENT_ADMIN}
        views={[{ id: "other-admin", full_name: "Other Admin", role: "medtech", until: "2026-09-28T07:40:00.000Z" }]}
      />,
    );
    expect(html).toContain("End now");
  });

  it("hides 'End now' on the current admin's own line", () => {
    const html = renderToStaticMarkup(
      <ActiveRoleViewsPanel
        now={now}
        currentAdminId={CURRENT_ADMIN}
        views={[{ id: CURRENT_ADMIN, full_name: "Self Admin", role: "reception", until: "2026-09-28T07:40:00.000Z" }]}
      />,
    );
    expect(html).not.toContain("End now");
  });
});
