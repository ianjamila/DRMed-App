import { describe, expect, it } from "vitest";
import {
  compareFlat,
  FLAT_DEFAULT_SORT,
  groupHaystack,
  tagBucket,
  upcomingRangeToIso,
  withinScheduledRange,
  type FlatSortableGroup,
} from "./flat-view";

function row(overrides: Partial<FlatSortableGroup["lead"]> = {}): FlatSortableGroup["lead"] {
  return {
    id: "id-1",
    created_at: "2026-09-01T00:00:00Z",
    scheduled_at: null,
    status: "confirmed",
    patient_name: null,
    patient_drm_id: null,
    patient_phone: null,
    walk_in_name: null,
    walk_in_phone: null,
    source: null,
    ...overrides,
  };
}

function group(overrides: Partial<FlatSortableGroup["lead"]> = {}): FlatSortableGroup {
  return { lead: row(overrides) };
}

describe("tagBucket", () => {
  it("stamps every group with the given bucket, leaving the rest untouched", () => {
    const groups = [group({ id: "a" }), group({ id: "b" })];
    const tagged = tagBucket(groups, "walkin");
    expect(tagged.map((g) => g.bucket)).toEqual(["walkin", "walkin"]);
    expect(tagged.map((g) => g.lead.id)).toEqual(["a", "b"]);
  });
});

describe("groupHaystack", () => {
  it("combines a linked patient's name, DRM-ID and phone", () => {
    const g = group({
      patient_name: "Cruz, Juan",
      patient_drm_id: "DRM-0042",
      patient_phone: "09171234567",
    });
    expect(groupHaystack(g)).toBe("Cruz, Juan DRM-0042 09171234567");
  });

  it("combines a walk-in's name and phone", () => {
    const g = group({ walk_in_name: "Maria Santos", walk_in_phone: "09991234567" });
    expect(groupHaystack(g)).toBe("Maria Santos 09991234567");
  });

  it("drops null/blank fields rather than leaving gaps", () => {
    const g = group({ patient_name: "Cruz, Juan" });
    expect(groupHaystack(g)).toBe("Cruz, Juan");
  });
});

describe("compareFlat", () => {
  it("sorts by created_at, honouring direction", () => {
    const older = group({ id: "a", created_at: "2026-09-01T00:00:00Z" });
    const newer = group({ id: "b", created_at: "2026-09-05T00:00:00Z" });
    expect(compareFlat(older, newer, { key: "created_at", dir: "desc" })).toBeGreaterThan(0);
    expect(compareFlat(older, newer, { key: "created_at", dir: "asc" })).toBeLessThan(0);
  });

  it("sinks a null scheduled_at to the bottom regardless of direction", () => {
    const withSlot = group({ id: "a", scheduled_at: "2026-09-10T01:00:00Z" });
    const noSlot = group({ id: "b", scheduled_at: null });
    expect(compareFlat(withSlot, noSlot, { key: "scheduled_at", dir: "asc" })).toBeLessThan(0);
    expect(compareFlat(withSlot, noSlot, { key: "scheduled_at", dir: "desc" })).toBeLessThan(0);
    expect(compareFlat(noSlot, withSlot, { key: "scheduled_at", dir: "asc" })).toBeGreaterThan(0);
    expect(compareFlat(noSlot, withSlot, { key: "scheduled_at", dir: "desc" })).toBeGreaterThan(0);
  });

  it("sorts patient by linked name, falling back to walk-in name", () => {
    const a = group({ id: "a", patient_name: "Alonzo, Bea" });
    const b = group({ id: "b", walk_in_name: "Zoe Reyes" });
    expect(compareFlat(a, b, { key: "patient", dir: "asc" })).toBeLessThan(0);
  });

  it("sorts status by its human label, not the raw enum", () => {
    const arrived = group({ id: "a", status: "arrived" });
    const pending = group({ id: "b", status: "pending_callback" });
    const asc = compareFlat(arrived, pending, { key: "status", dir: "asc" });
    const desc = compareFlat(arrived, pending, { key: "status", dir: "desc" });
    expect(Math.sign(asc)).toBe(-Math.sign(desc));
  });

  it("sorts source by its human label, treating a null source as 'Not recorded'", () => {
    const phone = group({ id: "a", source: "phone" });
    const notRecorded = group({ id: "b", source: null });
    // "Not recorded" < "Phone call" alphabetically.
    expect(compareFlat(notRecorded, phone, { key: "source", dir: "asc" })).toBeLessThan(0);
    expect(compareFlat(notRecorded, phone, { key: "source", dir: "desc" })).toBeGreaterThan(0);
  });

  it("falls back to an id tie-break so paging can't drop or repeat rows", () => {
    const a = group({ id: "a", created_at: "2026-09-01T00:00:00Z" });
    const b = group({ id: "b", created_at: "2026-09-01T00:00:00Z" });
    expect(compareFlat(a, b, FLAT_DEFAULT_SORT)).toBeLessThan(0);
    expect(compareFlat(b, a, FLAT_DEFAULT_SORT)).toBeGreaterThan(0);
  });
});

// Finding 2 (0167 patient-delete blocker): the appointments page's default
// "upcoming" loader caps at 31 days out, so its blocker link
// (`/staff/appointments?q=<DRM-ID>`) could not surface a confirmed
// appointment scheduled further out than that. A `q` search must lift the
// cap; the default (non-search) view must keep it.
describe("upcomingRangeToIso", () => {
  const cappedToIso = "2026-10-26T00:00:00.000Z"; // "today" + 31 days, in the shape loadScheduledRange builds

  it("keeps the 31-day cap when there is no search query", () => {
    expect(upcomingRangeToIso(false, cappedToIso)).toBe(cappedToIso);
  });

  it("lifts the cap (no upper bound) when a search query is present", () => {
    expect(upcomingRangeToIso(true, cappedToIso)).toBeNull();
  });
});

describe("withinScheduledRange", () => {
  const fromIso = "2026-09-26T00:00:00.000Z";
  const cappedToIso = "2026-10-27T00:00:00.000Z"; // fromIso + 31 days
  const farOutScheduledAt = "2026-11-10T00:00:00.000Z"; // 45 days past fromIso

  it("the default (capped) view excludes an appointment more than 31 days ahead", () => {
    expect(withinScheduledRange(farOutScheduledAt, fromIso, cappedToIso)).toBe(false);
  });

  it("a search (uncapped via upcomingRangeToIso) includes the same far-out appointment", () => {
    const searchToIso = upcomingRangeToIso(true, cappedToIso);
    expect(withinScheduledRange(farOutScheduledAt, fromIso, searchToIso)).toBe(true);
  });

  it("both views still exclude anything scheduled before fromIso", () => {
    const before = "2026-09-25T00:00:00.000Z";
    expect(withinScheduledRange(before, fromIso, cappedToIso)).toBe(false);
    expect(withinScheduledRange(before, fromIso, null)).toBe(false);
  });
});
