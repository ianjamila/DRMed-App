import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActiveRoleViewsPanel } from "./active-role-views-panel";

describe("ActiveRoleViewsPanel", () => {
  const now = new Date("2026-09-28T04:00:00.000Z");
  it("lists who is viewing as what, until when, and time left", () => {
    const html = renderToStaticMarkup(
      <ActiveRoleViewsPanel
        now={now}
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
    const html = renderToStaticMarkup(<ActiveRoleViewsPanel now={now} views={[]} />);
    expect(html).toContain("No one is viewing the app as another role.");
  });
});
