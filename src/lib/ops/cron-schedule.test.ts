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

  it("does not guess at a shape it cannot read", () => {
    for (const schedule of ["*/15 * * * *", "0 9 1 * *", "0 9 * * 1-5", "0 9 * *", "0 24 * * *", "60 9 * * *", "0 9 * * 8"]) {
      expect(describeCronSchedule(schedule)).toBe(`Custom schedule (${schedule}, UTC)`);
    }
  });

  it("reads every registered schedule without falling back", () => {
    for (const cron of CRON_HEARTBEATS) {
      expect(describeCronSchedule(cron.schedule), cron.key).toMatch(/^Every \w+ at \d{1,2}:\d{2} [AP]M$/);
    }
  });
});
