import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
const countResultViews = vi.hoisted(() => vi.fn());
vi.mock("@/lib/results/viewed-count", () => ({ countResultViews }));

import { loadRowUndoContext } from "./undo-scope.server";

type Row = Record<string, unknown>;

// result_test_requests is read twice: by test_request_id (which results is
// this row on?) then by result_id (who else shares them?).
function fakeClient(links: Row[], members: Row[]): SupabaseClient {
  const from = () => ({
    select: () => ({
      eq: async () => ({ data: links }),
      in: async () => ({ data: members }),
    }),
  });
  return { from } as unknown as SupabaseClient;
}

beforeEach(() => {
  countResultViews.mockReset();
  countResultViews.mockResolvedValue(0);
});

describe("loadRowUndoContext", () => {
  it("has no report scope for a single-link row", async () => {
    countResultViews.mockResolvedValue(2);
    const supabase = fakeClient(
      [{ result_id: "r1" }],
      [{ test_request_id: "t1", test_requests: { services: { report_groups: { name: "Chemistry" } } } }],
    );
    const out = await loadRowUndoContext(supabase, "t1");
    expect(out).toEqual({ reportScope: null, viewedCount: 2 });
    expect(countResultViews).toHaveBeenCalledTimes(1);
  });

  it("has no report scope for a row with no result yet", async () => {
    const out = await loadRowUndoContext(fakeClient([], []), "t1");
    expect(out).toEqual({ reportScope: null, viewedCount: 0 });
  });

  it("scopes a 3-member report, labels it, and sums the views", async () => {
    countResultViews.mockImplementation(async (id: string) => ({ t1: 1, t2: 2, t3: 4 })[id] ?? 0);
    const member = (id: string, rg: unknown) => ({ test_request_id: id, test_requests: { services: { report_groups: rg } } });
    const supabase = fakeClient(
      [{ result_id: "r1" }],
      [member("t1", [{ name: "Chemistry" }]), member("t2", { name: "Chemistry" }), member("t3", null), member("t2", null)],
    );
    const out = await loadRowUndoContext(supabase, "t2");
    expect(out.reportScope).toEqual({ memberIds: ["t1", "t2", "t3"], label: "Chemistry" });
    expect(out.viewedCount).toBe(7);
  });

  it("falls back to a generic label when the group has no name", async () => {
    const member = (id: string) => ({ test_request_id: id, test_requests: { services: { report_groups: null } } });
    const out = await loadRowUndoContext(fakeClient([{ result_id: "r1" }], [member("t1"), member("t2")]), "t1");
    expect(out.reportScope).toEqual({ memberIds: ["t1", "t2"], label: "combined" });
  });
});
