import { beforeEach, describe, expect, it, vi } from "vitest";

const auditMock = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("@/lib/audit/log", () => ({ audit: auditMock }));
vi.mock("@/lib/server/action-helpers", () => ({ ipAndAgent: vi.fn(async () => ({ ip: "1.2.3.4", ua: "ua" })) }));

import { reportCsvResponse } from "./csv-response";

const staff = { user_id: "u1" } as never;

beforeEach(() => vi.clearAllMocks());

describe("reportCsvResponse asOf", () => {
  it("writes asOf as the last line and does not count it as an exported row", async () => {
    const res = await reportCsvResponse({
      staff, report: "x", filename: "x.csv", rows: [["h"], ["1"], ["2"]], truncated: true, filters: {},
      asOf: "Numbers as of Oct 1, 2026, 9:14 AM",
    });
    const lines = (await res.text()).trim().split(/\r?\n/);
    expect(lines.at(-1)).toContain("Numbers as of Oct 1, 2026, 9:14 AM");
    expect(lines.at(-2)).toContain("TRUNCATED");
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ rows_exported: 2 }) }));
  });

  it("adds no extra line when asOf is omitted", async () => {
    const res = await reportCsvResponse({ staff, report: "x", filename: "x.csv", rows: [["h"], ["1"]], truncated: false, filters: {} });
    expect((await res.text()).trim().split(/\r?\n/)).toEqual(["h", "1"]);
  });
});
