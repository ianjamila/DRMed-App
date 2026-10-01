import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  revalidatePath: vi.fn(),
  requireAdminStaff: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/auth/require-admin", () => ({ requireAdminStaff: h.requireAdminStaff }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc: h.rpc }) }));

import { removeAdSpendAction, saveAdSpendAction } from "./ad-spend-actions";

const CSV =
  "platform,date,campaign,ad,spend,impressions,clicks,leads,bookings\n" +
  "Meta,2026-06-15,Beat the Hospital Price,Price vs Hospital,300,17600,300,48,29\n" +
  "Google,2026-06-15,Beat the Hospital Price,PEME · RSA,320,170,10,,0\n";

beforeEach(() => {
  h.rpc.mockReset();
  h.revalidatePath.mockReset();
  h.requireAdminStaff.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("saveAdSpendAction (the only write for the Ad Performance screen)", () => {
  it("re-parses the raw file and sends leads, platform bookings and the ad name to ad_spend_import", async () => {
    h.rpc.mockResolvedValue({ data: { inserted: 2, replaced: 0, days: 1 }, error: null });
    const res = await saveAdSpendAction(CSV);
    expect(res).toMatchObject({ ok: true, data: { inserted: 2, days: 1, rejected: [] } });
    const [name, args] = h.rpc.mock.calls[0]!;
    expect(name).toBe("ad_spend_import");
    expect(args.p_rejected_count).toBe(0);
    expect(args.p_rows).toEqual([
      expect.objectContaining({ platform: "meta", ad_key: "price vs hospital", ad_label: "Price vs Hospital", leads: 48, platform_bookings: 29, impressions: 17600, clicks: 300 }),
      expect.objectContaining({ platform: "google", ad_label: "PEME · RSA", leads: null, platform_bookings: 0 }),
    ]);
  });
  it("refreshes both screens that read the saved spend", async () => {
    h.rpc.mockResolvedValue({ data: { inserted: 1, replaced: 0, days: 1 }, error: null });
    await saveAdSpendAction(CSV);
    expect(h.revalidatePath.mock.calls.map((c) => c[0]).sort()).toEqual(["/staff/marketing", "/staff/marketing/patients"]);
  });
  it("counts rejected rows and passes the count to the database", async () => {
    h.rpc.mockResolvedValue({ data: { inserted: 1, replaced: 0, days: 1 }, error: null });
    const res = await saveAdSpendAction(CSV + "Meta,not a date,C,A,5,,,,\n");
    expect(res).toMatchObject({ ok: true, data: { rejected: [{ count: 1 }] } });
    expect(h.rpc.mock.calls[0]![1].p_rejected_count).toBe(1);
  });
  it("saves nothing and does not call the database for an empty, oversize or unreadable file", async () => {
    expect(await saveAdSpendAction("   ")).toEqual({ ok: false, error: "The file is empty." });
    expect(await saveAdSpendAction("x".repeat(5_000_001))).toMatchObject({ ok: false, error: expect.stringContaining("5 MB") });
    expect(await saveAdSpendAction("a,b\n1,2\n")).toMatchObject({ ok: false });
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
  it("maps the breakdown-change refusal to plain words, never the raw database text", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "22023", message: "... [breakdown change]" } });
    const res = await saveAdSpendAction(CSV);
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining("changes how saved spend is broken down") });
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
  it("a database failure says nothing was saved and does not refresh", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    expect(await saveAdSpendAction(CSV)).toEqual({ ok: false, error: "Couldn't save the ad spend. Nothing was saved — try again." });
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
  it("stops a non-admin before any parsing or database call", async () => {
    h.requireAdminStaff.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(saveAdSpendAction(CSV)).rejects.toThrow("NEXT_REDIRECT");
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

describe("removeAdSpendAction", () => {
  const form = (o: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) f.set(k, v);
    return f;
  };
  it("removes by platform and range and refreshes both screens", async () => {
    h.rpc.mockResolvedValue({ data: 7, error: null });
    const res = await removeAdSpendAction(null, form({ platform: "google", from: "2026-06-01", to: "2026-06-30" }));
    expect(res).toEqual({ ok: true, data: { deleted: 7 } });
    expect(h.rpc).toHaveBeenCalledWith("ad_spend_delete", { p_platform: "google", p_from: "2026-06-01", p_to: "2026-06-30" });
    expect(h.revalidatePath.mock.calls.map((c) => c[0]).sort()).toEqual(["/staff/marketing", "/staff/marketing/patients"]);
  });
  it("refuses a bad platform or range without calling the database", async () => {
    expect(await removeAdSpendAction(null, form({ platform: "tiktok", from: "2026-06-01", to: "2026-06-30" }))).toMatchObject({ ok: false });
    expect(await removeAdSpendAction(null, form({ platform: "meta", from: "2026-06-30", to: "2026-06-01" }))).toMatchObject({ ok: false });
    expect(h.rpc).not.toHaveBeenCalled();
  });
});
