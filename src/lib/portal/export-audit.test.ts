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
});
