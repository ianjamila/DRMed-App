import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The two Patient Sources CSV routes must answer 400 for an unusable period
// (reversed, over 400 days, or before 2023-12-01) instead of silently exporting
// this month under a filename that claims the requested dates (0193 P4).
const loaders = vi.hoisted(() => ({
  loadPatientSourcesSummary: vi.fn(),
  loadPatientSourcesSeries: vi.fn(),
  loadAllPeople: vi.fn(),
}));
const csv = vi.hoisted(() => vi.fn());

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/require-admin", () => ({ requireAdminStaff: vi.fn(async () => ({ user_id: "u1" })) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/dates/manila", async (orig) => ({ ...(await orig<typeof import("@/lib/dates/manila")>()), todayManilaISODate: () => "2026-09-28" }));
vi.mock("@/lib/reports/csv-response", () => ({ reportCsvResponse: csv }));
vi.mock("@/lib/marketing/patient-sources.server", () => loaders);

import { GET as seriesGet } from "./route";
import { GET as peopleGet } from "../patient-sources-people.csv/route";

const req = (path: string, qs: string) => new NextRequest(`http://localhost/api/admin/reports/${path}?${qs}`);

beforeEach(() => {
  vi.clearAllMocks();
  loaders.loadPatientSourcesSummary.mockResolvedValue({ ok: true, data: {} });
  loaders.loadPatientSourcesSeries.mockResolvedValue({ ok: true, data: { rows: [], truncated: false } });
  loaders.loadAllPeople.mockResolvedValue({ ok: true, data: { rows: [], truncated: false } });
  csv.mockResolvedValue(new Response("ok", { status: 200 }));
});

const BAD = [
  ["reversed", "from=2026-09-10&to=2026-09-01"],
  ["over 400 days", "from=2025-01-01&to=2026-09-10"],
  ["before 2023-12-01", "from=2023-11-30&to=2023-12-31"],
  ["malformed", "from=2026-9-1&to=2026-09-10"],
  ["half given", "from=2026-09-01"],
] as const;

describe.each([
  ["patient-sources.csv", seriesGet],
  ["patient-sources-people.csv", peopleGet],
])("%s", (name, GET) => {
  it.each(BAD)("answers 400 for a %s period and exports nothing", async (_label, qs) => {
    const res = await GET(req(name, qs));
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/can't be shown/);
    expect(csv).not.toHaveBeenCalled();
    expect(loaders.loadPatientSourcesSummary).not.toHaveBeenCalled();
    expect(loaders.loadPatientSourcesSeries).not.toHaveBeenCalled();
    expect(loaders.loadAllPeople).not.toHaveBeenCalled();
  });

  it("exports the requested period when it is valid (from exactly 2023-12-01 too)", async () => {
    for (const qs of ["from=2026-08-01&to=2026-08-31", "from=2023-12-01&to=2023-12-31"]) {
      csv.mockClear();
      const res = await GET(req(name, qs));
      expect(res.status).toBe(200);
      expect(csv).toHaveBeenCalledTimes(1);
      const [from, to] = qs.split("&").map((p) => p.split("=")[1]);
      expect(csv.mock.calls[0]![0].filters).toMatchObject({ from, to });
    }
  });

  it("with no period given, exports this month (the default is not an error)", async () => {
    const res = await GET(req(name, ""));
    expect(res.status).toBe(200);
    expect(csv.mock.calls[0]![0].filters).toMatchObject({ from: "2026-09-01", to: "2026-09-28" });
  });
});
