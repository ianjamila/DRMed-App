import { describe, expect, it } from "vitest";
import { activeRoleViews } from "./active-role-views";

const now = new Date("2026-09-28T04:00:00.000Z");
const row = (id: string, o: Partial<{ role: string; view_as_role: string | null; view_as_until: string | null; deleted_at: string | null }>) => ({
  id, full_name: `N-${id}`, role: "admin", view_as_role: null, view_as_until: null, deleted_at: null, ...o,
});

describe("activeRoleViews", () => {
  it("lists only admins with an active override, soonest ending first", () => {
    const out = activeRoleViews(
      [
        row("a", { view_as_role: "reception", view_as_until: "2026-09-28T07:00:00.000Z" }),
        row("b", { view_as_role: "medtech", view_as_until: "2026-09-28T05:00:00.000Z" }),
        row("c", { view_as_role: "reception", view_as_until: "2026-09-28T03:00:00.000Z" }),
        row("d", { role: "medtech", view_as_role: "reception", view_as_until: "2026-09-28T07:00:00.000Z" }),
        row("e", { view_as_role: "reception", view_as_until: "2026-09-28T07:00:00.000Z", deleted_at: "2026-09-01T00:00:00Z" }),
        row("f", {}),
      ],
      now,
    );
    expect(out.map((v) => [v.id, v.role])).toEqual([["b", "medtech"], ["a", "reception"]]);
    expect(out[0]).toMatchObject({ full_name: "N-b", until: "2026-09-28T05:00:00.000Z" });
  });
});
