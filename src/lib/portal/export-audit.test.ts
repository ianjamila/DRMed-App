import { describe, expect, it } from "vitest";
import { patientSafeAuditRows } from "./export-audit";

const row = (action: string, metadata: unknown) => ({
  id: 1,
  action,
  actor_type: "staff",
  created_at: "2026-09-25T06:00:00Z",
  metadata,
});

describe("patientSafeAuditRows — the data export never carries clinic-only text", () => {
  it("drops the reason a finished result was corrected, keeps the event", () => {
    const [out] = patientSafeAuditRows([
      row("result.amended", { reason: "wrong unit on glucose", amendment_seq: 2, test_request_ids: ["t1", "t2"] }),
    ]);
    expect(out.action).toBe("result.amended");
    expect(out.metadata).toEqual({ amendment_seq: 2, test_request_ids: ["t1", "t2"] });
    expect(JSON.stringify(out)).not.toContain("glucose");
  });

  it("drops every reason/note-like key, at any depth, and value snapshots", () => {
    const [out] = patientSafeAuditRows([
      row("test_request.release_undone", {
        reason: "wrong patient",
        delete_reason: "dup",
        prior_values_json: { k: 1 },
        staff_notes: "call back",
        nested: { remark: "x", keep: true },
        list: [{ comment: "y", ok: 1 }],
        viewed_count: 2,
      }),
    ]);
    expect(out.metadata).toEqual({ nested: { keep: true }, list: [{ ok: 1 }], viewed_count: 2 });
  });

  it("leaves patient download rows and empty metadata untouched", () => {
    const meta = { kind: "consolidated", drm_id: "DRM-1", test_request_ids: ["t1"] };
    expect(patientSafeAuditRows([row("result.downloaded", meta)])[0].metadata).toEqual(meta);
    expect(patientSafeAuditRows([row("x", null)])[0].metadata).toBeNull();
  });

  it("keeps known system codes under a reason key, still drops staff text", () => {
    const [a, b] = patientSafeAuditRows([
      { id: 1, action: "visit_pin.issued", actor_type: "staff", created_at: "t", metadata: { reason: "visit_created" } },
      { id: 2, action: "visit.deleted", actor_type: "staff", created_at: "t", metadata: { reason: "Wrong patient, re-entered" } },
    ]);
    expect(a.metadata).toEqual({ reason: "visit_created" });
    expect(b.metadata).toEqual({});
  });

  it("a system code under a non-reason key is untouched, and a code-like staff note is still dropped", () => {
    const [a] = patientSafeAuditRows([
      { id: 1, action: "x", actor_type: "staff", created_at: "t", metadata: { note: "visit_created!", kind: "manual_reissue" } },
    ]);
    expect(a.metadata).toEqual({ kind: "manual_reissue" });
  });

  it("result.notified (corrected) keeps ok/id/skipped/to, drops error and the skip reason", () => {
    const [out] = patientSafeAuditRows([
      row("result.notified", {
        kind: "corrected",
        sms: { ok: false, skipped: true, reason: "patient has no phone on file" },
        email: { ok: true, id: "abc123", to: "patient@example.com" },
      }),
    ]);
    expect(out.metadata).toEqual({
      kind: "corrected",
      sms: { ok: false, skipped: true },
      email: { ok: true, id: "abc123", to: "patient@example.com" },
    });
  });

  it("drops a provider error key at any depth, even when its value looks like a system code", () => {
    const [out] = patientSafeAuditRows([
      row("result.notified", {
        sms: { ok: false, error: "Semaphore 401 unauthorized" },
        nested: { error: "manual_reissue" },
      }),
    ]);
    expect(out.metadata).toEqual({ sms: { ok: false }, nested: {} });
  });
});
