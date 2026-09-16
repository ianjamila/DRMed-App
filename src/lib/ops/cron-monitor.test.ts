import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureCheckIn, flush } from "@sentry/nextjs";
import { CRON_HEARTBEATS } from "./cron-heartbeats";
import { withCronMonitor } from "./cron-monitor";

vi.mock("@sentry/nextjs", () => ({ captureCheckIn: vi.fn(), flush: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(captureCheckIn).mockReturnValue("check-in-id");
  vi.mocked(flush).mockResolvedValue(true);
});

const statuses = () => vi.mocked(captureCheckIn).mock.calls.map(([checkIn]) => checkIn.status);

describe("non-blocking cron check-ins", () => {
  it.each(CRON_HEARTBEATS)("upserts $key with its schedule and pairs start/end", async (cron) => {
    const response = Response.json({ processed: 0 });
    const run = vi.fn(async () => {
      expect(statuses()).toEqual(["in_progress"]);
      expect(flush).toHaveBeenCalledWith(2000);
      return response;
    });
    expect(await withCronMonitor(cron.key, run)).toBe(response);
    expect(run).toHaveBeenCalledOnce();
    expect(captureCheckIn).toHaveBeenNthCalledWith(1,
      { monitorSlug: cron.key, status: "in_progress" },
      { schedule: { type: "crontab", value: cron.schedule }, checkinMargin: 60, maxRuntime: 10, timezone: "UTC" },
    );
    expect(captureCheckIn).toHaveBeenNthCalledWith(2, {
      monitorSlug: cron.key, checkInId: "check-in-id", status: "ok", duration: expect.any(Number),
    });
    expect(flush).toHaveBeenCalledTimes(2);
    expect(response.bodyUsed).toBe(false);
  });

  it("ends returned HTTP failures as error without replacing the response", async () => {
    const response = Response.json({ error: "query failed" }, { status: 500 });
    expect(await withCronMonitor("recurring-bills", async () => response)).toBe(response);
    expect(statuses()).toEqual(["in_progress", "error"]);
  });

  it("ends partial HTTP-200 failures as error without consuming their body", async () => {
    const response = Response.json({ failures: ["failed item"] });
    expect(await withCronMonitor("appointment-reminders", async (markFailed) => {
      markFailed();
      return response;
    })).toBe(response);
    expect(statuses()).toEqual(["in_progress", "error"]);
    expect(await response.json()).toEqual({ failures: ["failed item"] });
  });

  it("ends thrown failures as error and preserves the original exception", async () => {
    const error = new Error("task failed");
    await expect(withCronMonitor("data-retention", async () => { throw error; })).rejects.toBe(error);
    expect(statuses()).toEqual(["in_progress", "error"]);
  });

  it("runs exactly once if starting the check-in throws", async () => {
    vi.mocked(captureCheckIn).mockImplementation(() => { throw new Error("Sentry failed"); });
    const response = Response.json({ ok: true });
    const run = vi.fn(async () => response);
    expect(await withCronMonitor("sync-accounting", run)).toBe(response);
    expect(run).toHaveBeenCalledOnce();
  });

  it("preserves the response if finishing the check-in throws", async () => {
    vi.mocked(captureCheckIn).mockReturnValueOnce("id").mockImplementationOnce(() => { throw new Error("Sentry failed"); });
    const response = Response.json({ ok: true });
    expect(await withCronMonitor("sync-accounting", async () => response)).toBe(response);
  });

  it("preserves the task error even if finishing the check-in throws", async () => {
    vi.mocked(captureCheckIn).mockReturnValueOnce("id").mockImplementationOnce(() => { throw new Error("Sentry failed"); });
    const error = new Error("original task error");
    await expect(withCronMonitor("sync-accounting", async () => { throw error; })).rejects.toBe(error);
  });

  it("still pairs the check-ins if both transport flushes reject", async () => {
    vi.mocked(flush).mockRejectedValue(new Error("network unavailable"));
    const response = Response.json({ ok: true });
    expect(await withCronMonitor("sync-accounting", async () => response)).toBe(response);
    expect(statuses()).toEqual(["in_progress", "ok"]);
  });

  it("preserves the result on a flush timeout", async () => {
    vi.mocked(flush).mockResolvedValue(false);
    const response = Response.json({ ok: true });
    expect(await withCronMonitor("sync-accounting", async () => response)).toBe(response);
    expect(statuses()).toEqual(["in_progress", "ok"]);
  });
});

describe("route check-in coverage", () => {
  it.each(CRON_HEARTBEATS)("$key checks in only after its authorization guard", (cron) => {
    const path = cron.path.split("?")[0];
    const source = readFileSync(`src/app${path}/route.ts`, "utf8");
    const invocation = source.indexOf("return withCronMonitor(");
    const unauthorized = source.indexOf('error: "unauthorized"');
    expect(unauthorized).toBeGreaterThanOrEqual(0);
    expect(invocation).toBeGreaterThan(unauthorized);
    expect(source.slice(0, invocation)).toMatch(/if \(!(?:secret|process\.env\.CRON_SECRET)/);
    expect(source.slice(invocation)).toContain(`"${cron.key}"`);
    expect(source.match(/return withCronMonitor\(/g)).toHaveLength(1);
  });

  it("uses the same parsed mode for the weekly slug and heartbeat action", () => {
    const source = readFileSync("src/app/api/cron/template-health/route.ts", "utf8");
    expect(source.match(/searchParams\.get\("mode"\)/g)).toHaveLength(1);
    expect(source).toContain('withCronMonitor(mode === "weekly" ? "template-health-weekly" : "template-health"');
    expect(source).toContain('action: mode === "weekly" ? "result_template.health_summary" : "result_template.health_alert"');
  });
});
