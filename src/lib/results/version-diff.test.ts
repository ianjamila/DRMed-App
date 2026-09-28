import { describe, expect, it } from "vitest";
import { changesPerAmendment, diffResultVersions, displayValue, type SnapshotValue } from "./version-diff";

const v = (id: string, name: string, si: number | null, flag: string | null = null, extra: Partial<SnapshotValue> = {}): SnapshotValue => ({
  parameter_id: id, parameter_name: name, numeric_value_si: si, numeric_value_conv: null,
  text_value: null, select_value: null, flag, is_blank: si == null, ...extra,
});

describe("displayValue", () => {
  it("shows a conv-only value (no SI reading) instead of reading as blank", () => {
    const x: SnapshotValue = {
      parameter_id: "w", parameter_name: "Weight", numeric_value_si: null,
      numeric_value_conv: 68.2, text_value: null, select_value: null,
      flag: null, is_blank: false,
    };
    expect(displayValue(x)).toBe("68.2");
  });
});

describe("diffResultVersions", () => {
  it("a conv-only value change appears with its old and new values", () => {
    const convOnly = (id: string, name: string, conv: number) => ({
      parameter_id: id, parameter_name: name, numeric_value_si: null, numeric_value_conv: conv,
      text_value: null, select_value: null, flag: null, is_blank: false,
    });
    const d = diffResultVersions([convOnly("w", "Weight", 68.2)], [convOnly("w", "Weight", 70.5)]);
    expect(d).toEqual([{ parameterId: "w", name: "Weight", before: "68.2", after: "70.5", flagBefore: null, flagAfter: null }]);
  });
  it("lists only changed parameters, in the new order", () => {
    const d = diffResultVersions([v("g", "Glucose", 55, "H"), v("c", "Cholesterol", 4)], [v("g", "Glucose", 5.5), v("c", "Cholesterol", 4)]);
    expect(d).toEqual([{ parameterId: "g", name: "Glucose", before: "55", after: "5.5", flagBefore: "H", flagAfter: null }]);
  });
  it("shows added and removed values as —", () => {
    const d = diffResultVersions([v("a", "A", 1)], [v("b", "B", 2)]);
    expect(d.map((x) => [x.name, x.before, x.after])).toEqual([["B", "—", "2"], ["A", "1", "—"]]);
  });
  it("compares text and select values", () => {
    const d = diffResultVersions(
      [v("u", "Urine colour", null, null, { select_value: "Yellow", is_blank: false })],
      [v("u", "Urine colour", null, null, { select_value: "Amber", is_blank: false })],
    );
    expect(d[0]).toMatchObject({ before: "Yellow", after: "Amber" });
  });
  it("a flag-only change counts", () => {
    expect(diffResultVersions([v("g", "G", 5, "H")], [v("g", "G", 5, null)])).toHaveLength(1);
  });

  // R2: displayValue() shows SI when it's present (numeric_value_si ??
  // numeric_value_conv), so an SI-unchanged, conv-only correction produced
  // identical before/after STRINGS and the diff read "Values unchanged" —
  // even though a real correction happened. "Changed" must be decided on
  // the underlying fields, and when that makes the plain display strings
  // collide, the conv value must still show so the change is visible.
  it("a conventional-unit-only change (SI unchanged) is not dropped as unchanged", () => {
    const withConv = (id: string, name: string, si: number, conv: number) => ({
      parameter_id: id, parameter_name: name, numeric_value_si: si, numeric_value_conv: conv,
      text_value: null, select_value: null, flag: null, is_blank: false,
    });
    const d = diffResultVersions(
      [withConv("g", "Glucose", 120, 6.7)],
      [withConv("g", "Glucose", 120, 7.0)],
    );
    expect(d).toHaveLength(1);
    // The SI-based display alone ("120") would be identical before and
    // after — the conv value must be visible in the text so staff can see
    // what actually changed.
    expect(d[0].before).not.toBe(d[0].after);
    expect(d[0].before).toContain("6.7");
    expect(d[0].after).toContain("7");
  });
});

describe("changesPerAmendment", () => {
  it("pairs each correction's snapshot with the next one, the last with current values", () => {
    const out = changesPerAmendment(
      [
        { id: "a1", amendment_seq: 1, amended_at: "t1", prior_values_json: [v("g", "G", 1)] },
        { id: "a2", amendment_seq: 2, amended_at: "t2", prior_values_json: [v("g", "G", 2)] },
      ],
      [v("g", "G", 3)],
    );
    expect(out.map((o) => [o.fromVersion, o.toVersion, o.changes[0]?.before, o.changes[0]?.after]))
      .toEqual([[2, 3, "2", "3"], [1, 2, "1", "2"]]); // newest first
  });
  it("a PDF-only correction (no snapshot) says so", () => {
    const [o] = changesPerAmendment([{ id: "a1", amendment_seq: 1, amended_at: "t", prior_values_json: null }], []);
    expect(o.structured).toBe(false);
  });
});
