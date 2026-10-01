import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const monitor = vi.hoisted(() => vi.fn(async (_key: string, run: (f: () => void) => Promise<Response>) => run(() => undefined)));
const cron = vi.hoisted(() => vi.fn(async () => Response.json({ ok: true })));
vi.mock("@/lib/ops/cron-monitor", () => ({ withCronMonitor: monitor }));
vi.mock("@/lib/marketing/patient-sources-digest-cron.server", () => ({ runDigestCron: cron }));

import { GET } from "./route";

const req = (qs = "", auth: string | null = "Bearer s3cret") =>
  new Request(`https://drmed.ph/api/cron/patient-sources-weekly${qs}`, { headers: auth ? { authorization: auth } : {} });

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "s3cret");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-11T23:00:00Z")); // Monday 2026-10-12, 07:00 Manila
  monitor.mockClear();
  cron.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("GET /api/cron/patient-sources-weekly", () => {
  it("is 401 without the secret, before anything runs", async () => {
    expect((await GET(req("", null))).status).toBe(401);
    expect((await GET(req("", "Bearer wrong"))).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "");
    expect((await GET(req("", "Bearer "))).status).toBe(401);
    expect(monitor).not.toHaveBeenCalled();
    expect(cron).not.toHaveBeenCalled();
  });

  it("runs the digest under the weekly monitor with no parameters", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(monitor).toHaveBeenCalledWith("patient-sources-weekly", expect.any(Function));
    expect(cron).toHaveBeenCalledWith("week", { ok: true, periodFrom: null, includeUnknown: false }, expect.any(Function));
  });

  it("passes a valid retry period and include_unknown through", async () => {
    await GET(req("?period_from=2026-10-05&include_unknown=1"));
    expect(cron).toHaveBeenCalledWith("week", { ok: true, periodFrom: "2026-10-05", includeUnknown: true }, expect.any(Function));
  });

  it("answers 400 for a bad retry WITHOUT starting the monitor", async () => {
    const res = await GET(req("?period_from=2026-10-07"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.stringMatching(/Monday/) });
    expect(monitor).not.toHaveBeenCalled();
    expect(cron).not.toHaveBeenCalled();
  });
});
