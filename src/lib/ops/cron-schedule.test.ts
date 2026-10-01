import { describe, expect, it } from "vitest";
import { CRON_HEARTBEATS } from "./cron-heartbeats";
import { describeCronSchedule } from "./cron-schedule";

describe("describeCronSchedule", () => {
  it("shifts a daily UTC schedule to Manila time", () => {
    expect(describeCronSchedule("0 9 * * *")).toBe("Every day at 5:00 PM");
    expect(describeCronSchedule("0 10 * * *")).toBe("Every day at 6:00 PM");
  });

  it("keeps minutes and wraps past midnight Manila", () => {
    expect(describeCronSchedule("30 17 * * *")).toBe("Every day at 1:30 AM");
    expect(describeCronSchedule("0 16 * * *")).toBe("Every day at 12:00 AM");
    expect(describeCronSchedule("0 4 * * *")).toBe("Every day at 12:00 PM");
  });

  it("names the Manila weekday, moving it forward when the shift crosses midnight", () => {
    expect(describeCronSchedule("0 1 * * 1")).toBe("Every Monday at 9:00 AM");
    expect(describeCronSchedule("0 23 * * 1")).toBe("Every Tuesday at 7:00 AM");
    expect(describeCronSchedule("0 20 * * 6")).toBe("Every Sunday at 4:00 AM");
    expect(describeCronSchedule("0 20 * * 0")).toBe("Every Monday at 4:00 AM");
    expect(describeCronSchedule("0 20 * * 7")).toBe("Every Monday at 4:00 AM");
  });

  it("reads an every-N-minutes schedule (the pg_cron release-notice sweeper)", () => {
    expect(describeCronSchedule("*/5 * * * *")).toBe("Every 5 minutes");
    expect(describeCronSchedule("*/1 * * * *")).toBe("Every 1 minute");
  });

  it("does not guess at a shape it cannot read", () => {
    for (const schedule of ["*/0 * * * *", "*/60 * * * *", "*/5 * * 1 *", "0 9 29 * *", "0 9 1 * 1", "0 9 1 1 *", "0 9 0 * *", "0 9 * * 1-5", "0 9 * *", "0 24 * * *", "60 9 * * *", "0 9 * * 8"]) {
      expect(describeCronSchedule(schedule)).toBe(`Custom schedule (${schedule}, UTC)`);
    }
  });

  it("reads a monthly run on one day of the month, moving the day forward when the Manila shift crosses midnight", () => {
    expect(describeCronSchedule("0 0 1 * *")).toBe("On the 1st of every month at 8:00 AM");
    expect(describeCronSchedule("0 9 1 * *")).toBe("On the 1st of every month at 5:00 PM");
    expect(describeCronSchedule("0 16 1 * *")).toBe("On the 2nd of every month at 12:00 AM");
    expect(describeCronSchedule("30 20 2 * *")).toBe("On the 3rd of every month at 4:30 AM");
    expect(describeCronSchedule("0 20 11 * *")).toBe("On the 12th of every month at 4:00 AM");
    expect(describeCronSchedule("0 20 21 * *")).toBe("On the 22nd of every month at 4:00 AM");
  });

  it("reads every registered schedule without falling back", () => {
    for (const cron of CRON_HEARTBEATS) {
      expect(describeCronSchedule(cron.schedule), cron.key).toMatch(/^(Every (\w+ at \d{1,2}:\d{2} [AP]M|\d+ minutes?)|On the \d{1,2}(st|nd|rd|th) of every month at \d{1,2}:\d{2} [AP]M)$/);
    }
  });
});
