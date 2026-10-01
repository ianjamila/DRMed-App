import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { fetchReportMembers } from "./report-members";

// A thenable stand-in for the supabase-js builder: every chained call returns it,
// awaiting it yields the canned response.
function fakeClient(response: { data: unknown[] | null; error: { message: string } | null }) {
  const calls: string[] = [];
  const builder: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown) => resolve(response),
  };
  for (const fn of ["select", "in", "order", "range"]) {
    builder[fn] = (...args: unknown[]) => {
      calls.push(`${fn}:${String(args[0])}`);
      return builder;
    };
  }
  const client = { from: (t: string) => (calls.push(`from:${t}`), builder) } as unknown as SupabaseClient<Database>;
  return { client, calls };
}

const tr = (id: string, over: Record<string, unknown> = {}) => ({
  id, status: "ready_for_release", deleted_at: null, visit_id: "v1", is_package_header: false,
  services: { section: "chemistry", kind: "lab_test" }, ...over,
});

describe("fetchReportMembers", () => {
  it("reads nothing for no results", async () => {
    const { client, calls } = fakeClient({ data: [], error: null });
    expect(await fetchReportMembers(client, [])).toEqual({ ok: true, byResult: new Map() });
    expect(calls).toEqual([]);
  });

  it("maps every link, including deleted, other-visit, doctor and null-service members", async () => {
    const { client, calls } = fakeClient({
      data: [
        { result_id: "R1", test_requests: tr("a") },
        { result_id: "R1", test_requests: tr("b", { deleted_at: "2026-09-01", visit_id: "v2", status: "in_progress" }) },
        { result_id: "R1", test_requests: [tr("c", { services: [{ section: null, kind: "doctor_consultation" }] })] },
        { result_id: "R2", test_requests: tr("d", { services: null, is_package_header: true }) },
      ],
      error: null,
    });
    const out = await fetchReportMembers(client, ["R1", "R2"]);
    expect(calls).toContain("from:result_test_requests");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.byResult.get("R1")).toEqual([
      { id: "a", status: "ready_for_release", deleted: false, visitId: "v1", section: "chemistry", isPackageHeader: false, isDoctor: false },
      { id: "b", status: "in_progress", deleted: true, visitId: "v2", section: "chemistry", isPackageHeader: false, isDoctor: false },
      { id: "c", status: "ready_for_release", deleted: false, visitId: "v1", section: null, isPackageHeader: false, isDoctor: true },
    ]);
    expect(out.byResult.get("R2")).toEqual([
      { id: "d", status: "ready_for_release", deleted: false, visitId: "v1", section: null, isPackageHeader: true, isDoctor: false },
    ]);
  });

  it("fails closed on a read error", async () => {
    const { client } = fakeClient({ data: null, error: { message: "boom" } });
    expect(await fetchReportMembers(client, ["R1"])).toEqual({ ok: false });
  });

  it("fails closed on a link whose test can't be read", async () => {
    const { client } = fakeClient({ data: [{ result_id: "R1", test_requests: null }], error: null });
    expect(await fetchReportMembers(client, ["R1"])).toEqual({ ok: false });
  });

  it("pages past PostgREST's 1000-row cap: 1000 then 2 rows are all returned", async () => {
    const pages = [
      Array.from({ length: 1000 }, (_, i) => ({ result_id: "R1", test_requests: tr(`t${i}`) })),
      [{ result_id: "R1", test_requests: tr("t1000") }, { result_id: "R1", test_requests: tr("t1001") }],
    ];
    const ranges: string[] = [];
    let n = 0;
    const builder: Record<string, unknown> = {
      then: (resolve: (v: unknown) => unknown) => resolve({ data: pages[n++] ?? [], error: null }),
    };
    for (const fn of ["select", "in", "order"]) builder[fn] = () => builder;
    builder.range = (from: number, to: number) => (ranges.push(`${from}-${to}`), builder);
    const client = { from: () => builder } as unknown as SupabaseClient<Database>;
    const out = await fetchReportMembers(client, ["R1"]);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.byResult.get("R1")).toHaveLength(1002);
    expect(ranges).toEqual(["0-999", "1000-1999"]);
  });
});
