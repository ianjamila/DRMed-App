import { describe, expect, it } from "vitest";
import { selectActivePins, type VisitPinCandidate } from "./pin-selection";

const NOW = Date.parse("2026-09-11T12:00:00.000Z");

function pin(overrides: Partial<VisitPinCandidate>): VisitPinCandidate {
  return {
    id: "pin-1",
    visit_id: "visit-1",
    pin_hash: "$2a$hash",
    failed_attempts: 0,
    locked_until: null,
    created_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("selectActivePins", () => {
  it("a single unlocked pin is active and not all-locked", () => {
    const out = selectActivePins([pin({})], NOW);
    expect(out.active).toHaveLength(1);
    expect(out.allLocked).toBe(false);
  });

  it("no rows at all: nothing active, not 'all locked' (caller treats this as no_active_pin)", () => {
    const out = selectActivePins([], NOW);
    expect(out.active).toEqual([]);
    expect(out.allLocked).toBe(false);
  });

  it("an older still-valid PIN is included alongside a newer one — the N9 bug", () => {
    const older = pin({ id: "pin-old", created_at: "2026-08-01T00:00:00.000Z" });
    const newer = pin({ id: "pin-new", created_at: "2026-09-10T00:00:00.000Z" });
    const out = selectActivePins([newer, older], NOW);
    expect(out.active.map((p) => p.id)).toEqual(["pin-new", "pin-old"]);
  });

  it("a locked row is excluded from active candidates", () => {
    const locked = pin({
      id: "pin-locked",
      locked_until: new Date(NOW + 60_000).toISOString(),
    });
    const out = selectActivePins([locked], NOW);
    expect(out.active).toEqual([]);
    expect(out.allLocked).toBe(true);
  });

  it("a lock that has already expired is treated as unlocked", () => {
    const expiredLock = pin({
      id: "pin-was-locked",
      locked_until: new Date(NOW - 60_000).toISOString(),
    });
    const out = selectActivePins([expiredLock], NOW);
    expect(out.active).toHaveLength(1);
    expect(out.allLocked).toBe(false);
  });

  it("mixed: one locked, one not — the unlocked one is still checkable, allLocked is false", () => {
    const locked = pin({ id: "pin-locked", locked_until: new Date(NOW + 60_000).toISOString() });
    const unlocked = pin({ id: "pin-ok" });
    const out = selectActivePins([locked, unlocked], NOW);
    expect(out.active.map((p) => p.id)).toEqual(["pin-ok"]);
    expect(out.allLocked).toBe(false);
  });

  it("all candidates locked: allLocked is true and active is empty", () => {
    const a = pin({ id: "a", locked_until: new Date(NOW + 60_000).toISOString() });
    const b = pin({ id: "b", locked_until: new Date(NOW + 120_000).toISOString() });
    const out = selectActivePins([a, b], NOW);
    expect(out.active).toEqual([]);
    expect(out.allLocked).toBe(true);
  });

  it("ordering is stable/deterministic (newest created_at first) and never mutates the input array", () => {
    const rows = [
      pin({ id: "a", created_at: "2026-09-01T00:00:00.000Z" }),
      pin({ id: "b", created_at: "2026-09-05T00:00:00.000Z" }),
      pin({ id: "c", created_at: "2026-09-03T00:00:00.000Z" }),
    ];
    const before = rows.map((p) => p.id);
    const out = selectActivePins(rows, NOW);
    expect(out.active.map((p) => p.id)).toEqual(["b", "c", "a"]);
    expect(rows.map((p) => p.id)).toEqual(before);
  });
});
