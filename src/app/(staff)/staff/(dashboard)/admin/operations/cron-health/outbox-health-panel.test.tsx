import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OutboxHealthPanel } from "./outbox-health-panel";
import type { OutboxCounts } from "@/lib/results/release-notice-health";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const counts = (over: Partial<OutboxCounts> = {}): OutboxCounts => ({
  queued: 3, overdue: 0, oldestOverdueAt: null, expiredLeases: 0, oldestExpiredLeaseAt: null,
  abandoned24h: 0, abandoned7d: 2, sent24h: 41, ...over,
});
const render = (enabled: boolean, c: OutboxCounts | null) => renderToStaticMarkup(<OutboxHealthPanel enabled={enabled} counts={c} now={NOW} />);

describe("OutboxHealthPanel", () => {
  it("shows the healthy pill, every number and the Result Follow-ups link", () => {
    const html = render(true, counts());
    expect(html).toContain("Result-ready messages (outbox)");
    expect(html).toMatch(/data-testid="outbox-status"[^>]*>Healthy</);
    expect(html).toMatch(/data-stat="sent-24h"[^>]*>.*?41/);
    expect(html).toMatch(/data-stat="abandoned-7d"[^>]*>.*?2/);
    expect(html).toContain('href="/staff/result-follow-ups"');
    expect(html).not.toContain('role="alert"');
  });

  it("shows a warning with its reason", () => {
    const html = render(true, counts({ abandoned24h: 2 }));
    expect(html).toMatch(/>Warning</);
    expect(html).toContain("2 messages were given up on in the last 24 hours");
  });

  it("shows a problem as an alert with the oldest age", () => {
    const html = render(true, counts({ overdue: 4, oldestOverdueAt: new Date(NOW - 150 * 60_000).toISOString() }));
    expect(html).toMatch(/>Problem</);
    expect(html).toContain('role="alert"');
    expect(html).toMatch(/data-stat="oldest-overdue"[^>]*>.*?150 min/);
  });

  it("shows the neutral switched-off state, not a problem, for a stale backlog", () => {
    const html = render(false, counts({ overdue: 4, oldestOverdueAt: new Date(NOW - 600 * 60_000).toISOString() }));
    expect(html).toMatch(/>Switched off</);
    expect(html).not.toMatch(/>Problem</);
    expect(html).toContain("switched off");
  });

  it("says unavailable when the counts could not be read", () => {
    const html = render(true, null);
    expect(html).toMatch(/>Unavailable</);
    expect(html).toContain("could not be loaded");
  });

  it("carries no patient contact detail", () => {
    expect(render(true, counts())).not.toMatch(/@|phone|\+63|09\d{9}/i);
  });
});
