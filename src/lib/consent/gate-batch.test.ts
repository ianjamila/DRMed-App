import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const seen: { ids?: string[]; error?: { message: string } } = {};
const reported: unknown[] = [];
vi.mock("@/lib/observability/report-error", () => ({
  reportError: async (a: unknown) => void reported.push(a),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        in: (_c: string, ids: string[]) => {
          seen.ids = ids;
          if (seen.error) return Promise.resolve({ data: null, error: seen.error });
          return Promise.resolve({ data: [{ id: "p1", consent_current: true }, { id: "p2", consent_current: false }], error: null });
        },
      }),
    }),
  }),
}));
const { getConsentCurrentByPatient } = await import("./gate");

describe("getConsentCurrentByPatient", () => {
  it("maps each patient to consent_current, de-duplicating ids", async () => {
    const m = await getConsentCurrentByPatient(["p1", "p2", "p1"]);
    expect(seen.ids).toEqual(["p1", "p2"]);
    expect(m.get("p1")).toBe(true);
    expect(m.get("p2")).toBe(false);
  });
  it("skips the query for an empty list", async () => {
    seen.ids = undefined;
    expect((await getConsentCurrentByPatient([])).size).toBe(0);
    expect(seen.ids).toBeUndefined();
  });
  it("reports a failed read and returns an empty map (reads as no consent on file)", async () => {
    seen.error = { message: "db down" };
    reported.length = 0;
    const m = await getConsentCurrentByPatient(["p1"]);
    seen.error = undefined;
    expect(m.size).toBe(0);
    expect(m.get("p1") ?? false).toBe(false);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ scope: "consent/current-by-patient" });
  });
});
