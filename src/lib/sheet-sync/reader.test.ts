import { describe, expect, it, vi } from "vitest";
import { readSheetTabs } from "./reader";

const ok = (ranges: Array<{ range: string; values?: unknown[][] }>) =>
  vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ valueRanges: ranges })));

describe("readSheetTabs", () => {
  it("makes ONE batchGet with unformatted values and serial dates, and maps tabs", async () => {
    const f = ok([
      { range: "'CUSTOMER LIST2'!A1:V9", values: [["h"]] },
      { range: "'LAB SERVICE'!A1:T9", values: [["h"]] },
      { range: "'DOCTOR CONSULTATION'!A1:R9" },
    ]);
    const tabs = await readSheetTabs({ sheetId: "SHEET", token: async () => "tok", fetchImpl: f as unknown as typeof fetch });
    expect(f).toHaveBeenCalledTimes(1);
    const url = String(f.mock.calls[0][0]);
    expect(url).toContain("/spreadsheets/SHEET/values:batchGet?");
    expect(url).toContain("valueRenderOption=UNFORMATTED_VALUE");
    expect(url).toContain("dateTimeRenderOption=SERIAL_NUMBER");
    expect(tabs.customers).toEqual([["h"]]);
    expect(tabs.consult).toEqual([]);
  });

  it("refuses a response whose ranges do not match the requested tabs", async () => {
    const f = ok([{ range: "'OTHER'!A1:B2", values: [] }, { range: "'LAB SERVICE'!A1", values: [] }, { range: "'DOCTOR CONSULTATION'!A1", values: [] }]);
    await expect(readSheetTabs({ sheetId: "S", token: async () => "t", fetchImpl: f as unknown as typeof fetch })).rejects.toThrow(/CUSTOMER LIST2/);
  });

  it("reports the HTTP status on failure", async () => {
    const f = vi.fn(async () => new Response("denied", { status: 403 }));
    await expect(readSheetTabs({ sheetId: "S", token: async () => "t", fetchImpl: f as unknown as typeof fetch })).rejects.toThrow(/403/);
  });
});
