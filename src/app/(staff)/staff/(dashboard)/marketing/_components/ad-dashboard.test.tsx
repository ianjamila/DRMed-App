// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
// The charts are recharts (code-split, browser-only) - not what these tests are about.
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("../ad-spend-actions", () => ({ saveAdSpendAction: vi.fn(), removeAdSpendAction: vi.fn() }));

import { saveAdSpendAction } from "../ad-spend-actions";
import { AdPerformanceDashboard } from "./ad-dashboard";
import { LEGACY_STORE_KEY, type AdRow } from "@/lib/marketing/ad-rows";
import type { AdSpendDbRow } from "@/lib/marketing/patient-sources";

const save = vi.mocked(saveAdSpendAction);
const saved = { ok: true as const, data: { inserted: 3, replaced: 0, days: 3, currencyAssumed: false, rejected: [] } };

const dbRow = (over: Partial<AdSpendDbRow> = {}): AdSpendDbRow => ({
  spend_date: "2026-09-01", platform: "meta", campaign_key: "beat the hospital price", campaign_label: "Beat the Hospital Price",
  ad_key: "price vs hospital", ad_label: "Price vs Hospital", spend_php: 300, impressions: 17600, clicks: 300, leads: 48, platform_bookings: 29, ...over,
});

type Props = Partial<React.ComponentProps<typeof AdPerformanceDashboard>>;
const ui = (p: Props = {}) => (
  <AdPerformanceDashboard
    dailyCampaignCounts={[]}
    campaignResultsTruncated={false}
    savedRows={[]}
    savedNotice={null}
    savedLoadFailed={false}
    savedCoverage={null}
    {...p}
  />
);

const legacyRow = (over: Partial<AdRow> = {}): AdRow => ({
  date: "2026-06-15", platform: "Meta", campaign: "Beat the Hospital Price", ad: "Price vs Hospital", spend: 300, impressions: 17600, clicks: 300, leads: 48, bookings: 29, ...over,
});
const putLegacy = (rows: AdRow[]) => window.localStorage.setItem(LEGACY_STORE_KEY, JSON.stringify(rows));

beforeEach(() => {
  window.localStorage.clear();
  router.refresh.mockClear();
  save.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const kpi = (label: string) => screen.getAllByText(label, { selector: "span" })[0]!.closest("div")!.parentElement!;

describe("data source: the database, not this browser", () => {
  it("renders the saved rows and says they are the clinic's data, not a sample", () => {
    render(ui({ savedRows: [dbRow(), dbRow({ spend_date: "2026-09-02", spend_php: 200, leads: 10, platform_bookings: 5 })] }));
    expect(within(kpi("Ad spend")).getByText("₱500")).toBeTruthy();
    expect(within(kpi("Patients captured")).getByText("34")).toBeTruthy(); // 29 + 5 platform-reported bookings
    expect(screen.getByText(/saved clinic data/)).toBeTruthy();
    expect(screen.queryByText(/sample data/i)).toBeNull();
  });
  it("shows the sample only while nothing is saved, clearly labelled", () => {
    render(ui());
    expect(screen.getAllByText(/sample data/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/not the clinic's\s+real ad spend/)).toBeTruthy();
  });
  it("never shows sample data in place of saved data that failed to load", () => {
    render(ui({ savedLoadFailed: true }));
    expect(screen.getByRole("alert").textContent).toMatch(/Couldn't load the saved ad spend/);
    expect(screen.queryByText(/This is sample data/i)).toBeNull();
    expect(within(kpi("Ad spend")).getByText("₱0")).toBeTruthy();
  });
  it("ignores whatever this browser has stored when the database has rows (no local data source)", () => {
    putLegacy([legacyRow({ spend: 99999 })]);
    render(ui({ savedRows: [dbRow()] }));
    expect(within(kpi("Ad spend")).getByText("₱300")).toBeTruthy();
  });
  it("shows the in-band notice about days that are not loaded, and the unknown-funnel note", () => {
    render(ui({ savedRows: [dbRow({ leads: null })], savedNotice: "This screen shows only the latest 400 days." }));
    expect(screen.getByRole("status", { name: "" }).textContent).toMatch(/latest 400 days/);
    expect(screen.getByText(/no leads or bookings figure/)).toBeTruthy();
  });
  it("offers the remove-by-platform-and-range form once something is saved", async () => {
    render(ui({ savedRows: [dbRow()], savedCoverage: { from: "2026-08-01", to: "2026-09-30" } }));
    await userEvent.click(screen.getByText(/Uploaded the wrong file/));
    expect(screen.getByRole("button", { name: /Remove saved spend/ })).toBeTruthy();
    expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe("2026-08-01");
    expect((screen.getByLabelText("To") as HTMLInputElement).value).toBe("2026-09-30");
  });
  it("has no remove form when nothing is saved, and no reset-to-sample button", () => {
    render(ui());
    expect(screen.queryByText(/Remove saved spend/)).toBeNull();
    expect(screen.queryByTitle("Reset to sample")).toBeNull();
  });
});

describe("upload", () => {
  const file = (text: string) => new File([text], "ads.csv", { type: "text/csv" });
  const upload = async (f: File) => {
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [f] } });
  };

  it("sends the raw file text to saveAdSpendAction, shows the saved note and refreshes; keeps nothing in this browser", async () => {
    save.mockResolvedValue(saved);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    render(ui());
    await upload(file("Day,Campaign,Cost\n2026-09-01,C,100\n"));
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith("Day,Campaign,Cost\n2026-09-01,C,100\n");
    expect(screen.getByText("Saved to clinic records: 3 days, 0 rows rejected.")).toBeTruthy();
    expect(setItem).not.toHaveBeenCalled();
  });
  it("does not refresh when the server refuses the file, and says why", async () => {
    save.mockResolvedValue({ ok: false, error: "This file is not a Meta or Google Ads export, and it has no Platform column." });
    render(ui());
    await upload(file("a,b\n1,2\n"));
    await waitFor(() => expect(screen.getByText(/Not saved to clinic records: This file is not a Meta or Google/)).toBeTruthy());
    expect(router.refresh).not.toHaveBeenCalled();
  });
  it("reports a failed upload call instead of pretending it saved", async () => {
    save.mockRejectedValue(new Error("network"));
    render(ui());
    await upload(file("x"));
    await waitFor(() => expect(screen.getByText(/the upload failed/)).toBeTruthy());
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

describe("one-time move of this browser's old rows", () => {
  it("shows no notice when the browser has nothing", () => {
    render(ui());
    expect(screen.queryByRole("region", { name: /only in this browser/ })).toBeNull();
  });
  it("shows the notice with the row count", () => {
    putLegacy([legacyRow(), legacyRow({ date: "2026-06-16" })]);
    render(ui());
    const region = screen.getByRole("region", { name: /only in this browser/ });
    expect(region.textContent).toMatch(/This browser still has 2 ad rows from earlier uploads that were never saved with leads and bookings/);
    expect(within(region).getByRole("button", { name: "Save them to clinic records" })).toBeTruthy();
    expect(within(region).getByRole("button", { name: "Discard" })).toBeTruthy();
  });
  it("Save sends the rows (as an upload file) through saveAdSpendAction, then clears the key and refreshes", async () => {
    putLegacy([legacyRow(), legacyRow({ date: "2026-06-16", platform: "Google", ad: "PEME · RSA", leads: 3, bookings: 2 })]);
    save.mockResolvedValue(saved);
    render(ui());
    await userEvent.click(screen.getByRole("button", { name: "Save them to clinic records" }));
    await waitFor(() => expect(window.localStorage.getItem(LEGACY_STORE_KEY)).toBeNull());
    const csv = save.mock.calls[0]![0];
    expect(csv.split("\n")[0]).toBe("platform,date,campaign,ad,spend,impressions,clicks,leads,bookings");
    expect(csv).toContain("Meta,2026-06-15,Beat the Hospital Price,Price vs Hospital,300,17600,300,48,29");
    expect(csv).toContain("Google,2026-06-16,Beat the Hospital Price,PEME · RSA,300,17600,300,3,2");
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("region", { name: /only in this browser/ })).toBeNull();
    expect(screen.getByText(/Saved to clinic records/)).toBeTruthy();
  });
  it("keeps the browser's copy and the notice when the save fails", async () => {
    putLegacy([legacyRow()]);
    save.mockResolvedValue({ ok: false, error: "Couldn't save the ad spend. Nothing was saved — try again." });
    render(ui());
    await userEvent.click(screen.getByRole("button", { name: "Save them to clinic records" }));
    await waitFor(() => expect(screen.getByText(/Not saved to clinic records/)).toBeTruthy());
    expect(window.localStorage.getItem(LEGACY_STORE_KEY)).not.toBeNull();
    expect(screen.getByRole("region", { name: /only in this browser/ })).toBeTruthy();
    expect(router.refresh).not.toHaveBeenCalled();
  });
  it("keeps the browser's copy when the save is ok but some rows were rejected, and says how many and why", async () => {
    putLegacy([legacyRow(), legacyRow({ date: "2026-06-16" })]);
    save.mockResolvedValue({ ok: true, data: { inserted: 1, replaced: 0, days: 1, currencyAssumed: false, rejected: [{ reason: "Spend is blank or not a valid amount", count: 1 }] } });
    render(ui());
    await userEvent.click(screen.getByRole("button", { name: "Save them to clinic records" }));
    await waitFor(() => expect(screen.getByText(/1 row rejected/)).toBeTruthy());
    expect(window.localStorage.getItem(LEGACY_STORE_KEY)).not.toBeNull();
    expect(screen.getByRole("region", { name: /only in this browser/ })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/Spend is blank or not a valid amount/);
    expect(screen.getByRole("status").textContent).toMatch(/Discard/);
  });
  it("keeps the browser's copy when the save is ok but nothing was saved", async () => {
    putLegacy([legacyRow()]);
    save.mockResolvedValue({ ok: true, data: { inserted: 0, replaced: 0, days: 0, currencyAssumed: false, rejected: [] } });
    render(ui());
    await userEvent.click(screen.getByRole("button", { name: "Save them to clinic records" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Nothing was saved/));
    expect(window.localStorage.getItem(LEGACY_STORE_KEY)).not.toBeNull();
    expect(screen.getByRole("region", { name: /only in this browser/ })).toBeTruthy();
  });
  it("the notice warns that rows on other platforms are discarded and that older rows overwrite newer saved numbers", () => {
    putLegacy([legacyRow(), legacyRow({ platform: "Other" })]);
    render(ui());
    const text = screen.getByRole("region", { name: /only in this browser/ }).textContent ?? "";
    expect(text).toMatch(/will be discarded — only Meta and Google can be saved/);
    expect(text).toMatch(/over any newer saved numbers for the same day and ad/);
  });
  it("keeps the browser's copy when the save call itself throws", async () => {
    putLegacy([legacyRow()]);
    save.mockRejectedValue(new Error("offline"));
    render(ui());
    await userEvent.click(screen.getByRole("button", { name: "Save them to clinic records" }));
    await waitFor(() => expect(screen.getByText(/This browser's copy is still here/)).toBeTruthy());
    expect(window.localStorage.getItem(LEGACY_STORE_KEY)).not.toBeNull();
  });
  it("Discard clears the key without saving anything", async () => {
    putLegacy([legacyRow()]);
    render(ui());
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(window.localStorage.getItem(LEGACY_STORE_KEY)).toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: /only in this browser/ })).toBeNull();
  });
  it("leaves out rows for other platforms and says so; nothing saveable means no call", async () => {
    putLegacy([legacyRow({ platform: "Other" })]);
    render(ui());
    await userEvent.click(screen.getByRole("button", { name: "Save them to clinic records" }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByText(/Nothing here can be saved/)).toBeTruthy();
    cleanup();
    putLegacy([legacyRow(), legacyRow({ platform: "Other" })]);
    render(ui());
    expect(screen.getByRole("region", { name: /only in this browser/ }).textContent).toMatch(/1 row on platform "Other" will be discarded — only Meta and Google can be saved/);
  });
  it("ignores corrupt stored data", () => {
    window.localStorage.setItem(LEGACY_STORE_KEY, "{not json");
    render(ui());
    expect(screen.queryByRole("region", { name: /only in this browser/ })).toBeNull();
  });
});

describe("browser storage blocked (Chrome 'block all site data')", () => {
  it("still renders the saved rows, with no notice, when reading storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    render(ui({ savedRows: [dbRow()] }));
    expect(within(kpi("Ad spend")).getByText("₱300")).toBeTruthy();
    expect(screen.queryByRole("region", { name: /only in this browser/ })).toBeNull();
  });
  it("renders even when the window.localStorage getter itself throws", () => {
    const orig = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("denied", "SecurityError"); } });
    try {
      render(ui());
      expect(screen.getAllByText(/sample data/i).length).toBeGreaterThan(0);
    } finally {
      Object.defineProperty(window, "localStorage", orig);
    }
  });
  it("Discard and a successful Save still work when clearing the key throws", async () => {
    putLegacy([legacyRow()]);
    save.mockResolvedValue(saved);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    render(ui());
    await userEvent.click(screen.getByRole("button", { name: "Save them to clinic records" }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: /only in this browser/ })).toBeNull();
  });
});
