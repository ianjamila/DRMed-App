import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const seen: { ids?: string[] } = {};
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        in: (_c: string, ids: string[]) => {
          seen.ids = ids;
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
});
