import { describe, expect, it } from "vitest";
import { foldReleaseEvent, type ReleaseFoldItem, isFreshRelease, releaseEventKey } from "./release-notifications";

describe("release bell items", () => {
  const empty = () => ({ items: [] as ReleaseFoldItem[], seen: new Set<string>() });
  const ev = (over = {}) => ({ testRequestId: "t1", releasedAt: "2026-09-28T08:00:00Z", visitId: "v1",
    who: "Cruz, Ana", visitNumber: "0044", ts: 1_000, ...over });
  it("keys an event by test + release instant, so a later update of the same release is a repeat", () => {
    expect(releaseEventKey(ev())).toBe("t1@2026-09-28T08:00:00Z");
  });
  it("judges freshness from released_at", () => {
    const now = Date.parse("2026-09-28T08:01:00Z");
    expect(isFreshRelease({ status: "released", released_at: "2026-09-28T08:00:00Z" }, now)).toBe(true);
    expect(isFreshRelease({ status: "released", released_at: "2026-09-28T07:50:00Z" }, now)).toBe(false);
  });
  it("is not fresh without a release instant or when not released", () => {
    const now = Date.parse("2026-09-28T08:01:00Z");
    expect(isFreshRelease({ status: "released", released_at: null }, now)).toBe(false);
    expect(isFreshRelease({ status: "ready_for_release", released_at: "2026-09-28T08:00:30Z" }, now)).toBe(false);
  });
  it("drops a repeated event", () => {
    const a = foldReleaseEvent(empty(), ev());
    const b = foldReleaseEvent(a, ev({ ts: 2_000 }));
    expect(b.items).toHaveLength(1);
    expect(b.isNew).toBe(false);
  });
  it("merges one visit's releases within a minute, starts a new item after", () => {
    const a = foldReleaseEvent(empty(), ev());
    expect(a.items[0].title).toBe("1 result released for Cruz, Ana");
    expect(a.items[0].subtitle).toMatch(/^Visit #0044 · /);
    expect(a.items[0].href).toBe("/staff/queue?filter=released_today");
    const b = foldReleaseEvent(a, ev({ testRequestId: "t2", ts: 20_000 }));
    expect(b.items).toHaveLength(1);
    expect(b.items[0].title).toBe("2 results released for Cruz, Ana");
    const c = foldReleaseEvent(b, ev({ testRequestId: "t3", ts: 200_000 }));
    expect(c.items).toHaveLength(2);
    expect(new Set(c.items.map((i) => i.id)).size).toBe(2);
    expect(c.isNew).toBe(true);
  });
  it("does not merge releases of different visits", () => {
    const a = foldReleaseEvent(empty(), ev());
    const b = foldReleaseEvent(a, ev({ testRequestId: "t2", visitId: "v2", ts: 2_000 }));
    expect(b.items).toHaveLength(2);
  });
});
