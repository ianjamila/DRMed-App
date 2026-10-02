import { describe, expect, it } from "vitest";
import {
  EXPIRED_LEASE_PROBLEM_MS,
  EXPIRED_LEASE_WARNING_MS,
  OVERDUE_PROBLEM_MS,
  OVERDUE_WARNING_MS,
  evaluateOutboxHealth,
  shouldAlertBacklog,
  type OutboxCounts,
} from "./release-notice-health";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

const counts = (over: Partial<OutboxCounts> = {}): OutboxCounts => ({
  queued: 0,
  overdue: 0,
  oldestOverdueAt: null,
  expiredLeases: 0,
  oldestExpiredLeaseAt: null,
  abandoned24h: 0,
  abandoned7d: 0,
  sent24h: 0,
  ...over,
});

describe("evaluateOutboxHealth", () => {
  it("is neutral 'off' when the flag is off, even with a stale backlog", () => {
    const h = evaluateOutboxHealth({ enabled: false, counts: counts({ queued: 9, overdue: 9, oldestOverdueAt: ago(5 * 60 * MIN), abandoned24h: 2 }), now: NOW });
    expect(h.status).toBe("off");
    expect(h.reasons).toEqual(["The result-ready message outbox is switched off, so nothing is being sent and waiting messages are expected."]);
  });

  it("is ok when empty", () => {
    const h = evaluateOutboxHealth({ enabled: true, counts: counts(), now: NOW });
    expect(h).toMatchObject({ status: "ok", reasons: [] });
    expect(h.oldestOverdueMinutes).toBeNull();
  });

  it("is ok when the only waiting rows are not yet due (retry back-off)", () => {
    expect(evaluateOutboxHealth({ enabled: true, counts: counts({ queued: 4 }), now: NOW }).status).toBe("ok");
  });

  it("overdue exactly at the warning threshold is still ok; one ms past is a warning", () => {
    const at = counts({ queued: 1, overdue: 1, oldestOverdueAt: ago(OVERDUE_WARNING_MS) });
    expect(evaluateOutboxHealth({ enabled: true, counts: at, now: NOW }).status).toBe("ok");
    const past = counts({ queued: 1, overdue: 1, oldestOverdueAt: ago(OVERDUE_WARNING_MS + 1) });
    const h = evaluateOutboxHealth({ enabled: true, counts: past, now: NOW });
    expect(h.status).toBe("warning");
    expect(h.reasons[0]).toMatch(/30 minutes/);
  });

  it("overdue at the problem threshold is a warning; past it is a problem", () => {
    const at = counts({ overdue: 2, oldestOverdueAt: ago(OVERDUE_PROBLEM_MS) });
    expect(evaluateOutboxHealth({ enabled: true, counts: at, now: NOW }).status).toBe("warning");
    const past = counts({ overdue: 2, oldestOverdueAt: ago(OVERDUE_PROBLEM_MS + 1) });
    const h = evaluateOutboxHealth({ enabled: true, counts: past, now: NOW });
    expect(h.status).toBe("problem");
    expect(h.oldestOverdueMinutes).toBe(120);
  });

  it("expired lease thresholds: under warning ok, past warning warning, past problem problem", () => {
    const ok = counts({ expiredLeases: 1, oldestExpiredLeaseAt: ago(EXPIRED_LEASE_WARNING_MS) });
    expect(evaluateOutboxHealth({ enabled: true, counts: ok, now: NOW }).status).toBe("ok");
    const warn = counts({ expiredLeases: 1, oldestExpiredLeaseAt: ago(EXPIRED_LEASE_WARNING_MS + 1) });
    expect(evaluateOutboxHealth({ enabled: true, counts: warn, now: NOW }).status).toBe("warning");
    const edge = counts({ expiredLeases: 1, oldestExpiredLeaseAt: ago(EXPIRED_LEASE_PROBLEM_MS) });
    expect(evaluateOutboxHealth({ enabled: true, counts: edge, now: NOW }).status).toBe("warning");
    const prob = counts({ expiredLeases: 1, oldestExpiredLeaseAt: ago(EXPIRED_LEASE_PROBLEM_MS + 1) });
    expect(evaluateOutboxHealth({ enabled: true, counts: prob, now: NOW }).status).toBe("problem");
  });

  it("any abandoned in 24h is a warning; abandoned only in 7d is ok", () => {
    const h = evaluateOutboxHealth({ enabled: true, counts: counts({ abandoned24h: 1, abandoned7d: 1 }), now: NOW });
    expect(h.status).toBe("warning");
    expect(h.reasons[0]).toMatch(/1 message was given up on/);
    expect(evaluateOutboxHealth({ enabled: true, counts: counts({ abandoned7d: 3 }), now: NOW }).status).toBe("ok");
  });

  it("the worst status wins and every reason is listed", () => {
    const h = evaluateOutboxHealth({
      enabled: true,
      counts: counts({ overdue: 3, oldestOverdueAt: ago(3 * 60 * MIN), abandoned24h: 2, abandoned7d: 2 }),
      now: NOW,
    });
    expect(h.status).toBe("problem");
    expect(h.reasons).toHaveLength(2);
  });

  it("ignores a missing timestamp when a count is positive (never a false problem)", () => {
    expect(evaluateOutboxHealth({ enabled: true, counts: counts({ overdue: 1, oldestOverdueAt: null }), now: NOW }).status).toBe("ok");
  });
});

describe("shouldAlertBacklog", () => {
  it("alerts only when the status is problem and no recent alert exists", () => {
    expect(shouldAlertBacklog("problem", false)).toBe(true);
    expect(shouldAlertBacklog("problem", true)).toBe(false);
    expect(shouldAlertBacklog("warning", false)).toBe(false);
    expect(shouldAlertBacklog("ok", false)).toBe(false);
    expect(shouldAlertBacklog("off", false)).toBe(false);
  });
});
