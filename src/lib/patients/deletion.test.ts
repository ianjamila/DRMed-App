import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BLOCKER_KINDS,
  BLOCKER_GROUP_LABEL,
  DELETE_REASONS,
  DELETE_REASON_LABEL,
  DeletePatientSchema,
  groupBlockers,
  keptSummary,
  parseBlockerDetail,
  parseBlockers,
  parseKeptCounts,
  parseLifecycleResult,
} from "./deletion";

const MIGRATION = readFileSync(
  join(process.cwd(), "supabase", "migrations", "0167_patient_soft_delete.sql"),
  "utf8",
);

const uuid = "11111111-1111-4111-8111-111111111111";

describe("DeletePatientSchema", () => {
  it("accepts each reason, trimming the note", () => {
    for (const reason of DELETE_REASONS) {
      const r = DeletePatientSchema.safeParse({ patientId: uuid, reason, note: "  why  " });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.note).toBe("why");
    }
  });
  it("turns a blank note into undefined", () => {
    const r = DeletePatientSchema.safeParse({ patientId: uuid, reason: "duplicate", note: "   " });
    expect(r.success && r.data.note).toBe(undefined);
  });
  it("requires a note for Other", () => {
    const r = DeletePatientSchema.safeParse({ patientId: uuid, reason: "other", note: " " });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toBe("Add a note when the reason is Other.");
  });
  it("caps the note at 500 characters", () => {
    expect(DeletePatientSchema.safeParse({ patientId: uuid, reason: "other", note: "x".repeat(500) }).success).toBe(true);
    expect(DeletePatientSchema.safeParse({ patientId: uuid, reason: "other", note: "x".repeat(501) }).success).toBe(false);
  });
  it("rejects an unknown reason and a non-uuid id", () => {
    expect(DeletePatientSchema.safeParse({ patientId: uuid, reason: "oops" }).success).toBe(false);
    expect(DeletePatientSchema.safeParse({ patientId: "DRM-0001", reason: "duplicate" }).success).toBe(false);
  });
});

describe("pinned to migration 0167", () => {
  it("uses the same four reasons as the row check", () => {
    const m = /delete_reason in \(([^)]*)\)/.exec(MIGRATION);
    const sqlReasons = m![1]!.split(",").map((s) => s.trim().replace(/'/g, ""));
    expect([...DELETE_REASONS].sort()).toEqual(sqlReasons.sort());
    expect(Object.keys(DELETE_REASON_LABEL).sort()).toEqual([...DELETE_REASONS].sort());
  });
  it("knows every blocker kind the SQL can emit", () => {
    // "recon" (not "blockers") is where 'hmo_reconciliation' is literally
    // written; "blockers" only re-selects r.kind from it.
    const blockersSection = MIGRATION.slice(
      MIGRATION.indexOf("recon as (\n"),
      MIGRATION.indexOf("deduped as ("),
    );
    const sqlKinds = [...blockersSection.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]!);
    expect(new Set(sqlKinds)).toEqual(new Set(BLOCKER_KINDS));
    expect(Object.keys(BLOCKER_GROUP_LABEL).sort()).toEqual([...BLOCKER_KINDS].sort());
  });
});

describe("parseBlockers", () => {
  it("keeps valid rows and turns amounts into numbers", () => {
    const rows = parseBlockers([
      { kind: "balance", resource_id: uuid, visit_id: uuid, label: "Visit 0001 is unpaid", amount_php: "600.00", href: "/staff/visits/x" },
      { kind: "appointment", resource_id: uuid, visit_id: null, label: "Callback", amount_php: null, href: null },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.amount_php).toBe(600);
    expect(rows[1]!.amount_php).toBeNull();
  });
  it("keeps an unknown kind rather than dropping a blocker", () => {
    const rows = parseBlockers([{ kind: "future_kind", resource_id: uuid, visit_id: null, label: "x", amount_php: null, href: null }]);
    expect(rows[0]!.kind).toBe("future_kind");
  });
  it("returns [] for junk", () => {
    expect(parseBlockers(null)).toEqual([]);
    expect(parseBlockers("nope")).toEqual([]);
  });
});

describe("parseBlockerDetail", () => {
  it("reads the JSON the SQL puts in DETAIL", () => {
    const detail = JSON.stringify([{ kind: "clinical", resource_id: uuid, visit_id: uuid, label: "CBC is requested", amount_php: null, href: "/staff/visits/v" }]);
    expect(parseBlockerDetail(detail)[0]!.label).toBe("CBC is requested");
  });
  it("never throws", () => {
    expect(parseBlockerDetail("{not json")).toEqual([]);
    expect(parseBlockerDetail(undefined)).toEqual([]);
  });
});

describe("groupBlockers", () => {
  it("groups by kind in first-seen order", () => {
    const g = groupBlockers(parseBlockers([
      { kind: "appointment", resource_id: "a", visit_id: null, label: "A", amount_php: null, href: null },
      { kind: "clinical", resource_id: "b", visit_id: null, label: "B", amount_php: null, href: null },
      { kind: "appointment", resource_id: "c", visit_id: null, label: "C", amount_php: null, href: null },
    ]));
    expect(g.map((x) => [x.kind, x.items.length])).toEqual([["appointment", 2], ["clinical", 1]]);
    expect(g[0]!.title).toBe("Open appointments");
  });
});

describe("kept counts", () => {
  it("parses the RPC row and pluralises", () => {
    const k = parseKeptCounts({ visits: 2, payments: 1, appointments: 0, consents: 3 });
    expect(keptSummary(k)).toBe("2 visits, 1 payment, 0 appointments, 3 consent records");
  });
  it("defaults missing numbers to zero", () => {
    expect(parseKeptCounts(null)).toEqual({ visits: 0, payments: 0, appointments: 0, consents: 0 });
  });
});

describe("parseLifecycleResult", () => {
  it("reads the delete/restore return value", () => {
    expect(parseLifecycleResult({ patient_id: uuid, drm_id: "DRM-1234", kept: { visits: 1 } })).toEqual({
      patientId: uuid,
      drmId: "DRM-1234",
    });
    expect(parseLifecycleResult(null)).toBeNull();
  });
});
