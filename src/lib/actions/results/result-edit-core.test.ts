import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The commit protocol's uncertain paths (0172, Codex review of #223): what
 * commitResultEdit does when the RPC's answer is lost or refused, and that a
 * commit confirmed only by the probe still writes the critical-value audit row
 * (flagged outcome_replayed) instead of silently skipping it.
 *
 * `npm test` has no database: the admin client is faked — Storage upload /
 * remove, the RPC, and the result_amendments probe by attempt_id — and the
 * audit writer is captured.
 */

vi.mock("server-only", () => ({}));

const fx = vi.hoisted(() => ({
  rpc: null as null | (() => Promise<{ data: unknown; error: { code?: string | null; message: string } | null }>),
  probe: { data: null as { id: string } | null, error: null as { message: string } | null },
  uploads: [] as { bucket: string; path: string }[],
  removed: [] as { bucket: string; paths: string[] }[],
  audits: [] as Record<string, unknown>[],
  rpcCalls: 0,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string) => {
          fx.uploads.push({ bucket, path });
          return { error: null };
        },
        remove: async (paths: string[]) => {
          fx.removed.push({ bucket, paths });
          return { error: null };
        },
      }),
    },
    rpc: async () => {
      fx.rpcCalls += 1;
      return fx.rpc!();
    },
    from: (table: string) => {
      if (table !== "result_amendments") throw new Error(`unexpected table ${table}`);
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => fx.probe,
      };
      return q;
    },
  }),
}));

vi.mock("@/lib/audit/log", () => ({
  audit: async (entry: Record<string, unknown>) => {
    fx.audits.push(entry);
  },
}));

import type { AlertRow } from "@/lib/results/value-rows";
import { auditAlertChanges, commitResultEdit, UNCONFIRMED_SAVE_ERROR } from "./result-edit-core";

const ALERT = {
  parameter_id: "p-k",
  parameter_name: "Potassium",
  direction: "high",
  observed_value_si: 7.1,
  threshold_si: 6.5,
} as unknown as AlertRow;

function args(over: Partial<Parameters<typeof commitResultEdit>[0]> = {}) {
  return {
    resultId: "r1",
    expectedAmendmentCount: 0,
    currentStoragePath: "visit/r1.pdf",
    editorId: "u1",
    reason: "wrong unit",
    anchorTestRequestId: "t1",
    pdf: Buffer.from("%PDF-1.4"),
    values: [],
    newImage: null,
    alerts: [ALERT],
    ...over,
  } as Parameters<typeof commitResultEdit>[0];
}

beforeEach(() => {
  fx.rpc = null;
  fx.probe = { data: null, error: null };
  fx.uploads = [];
  fx.removed = [];
  fx.audits = [];
  fx.rpcCalls = 0;
});

describe("commitResultEdit — a lost response", () => {
  it("is confirmed by the attempt probe: replayed, alerts = what this edit SENT, nothing removed", async () => {
    fx.rpc = async () => {
      throw new Error("fetch failed");
    };
    fx.probe = { data: { id: "am-1" }, error: null };

    const out = await commitResultEdit(args());

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.replayed).toBe(true);
    expect(out.data.alertsAdded).toEqual([ALERT]);
    expect(out.data.amendmentSeq).toBe(1);
    expect(out.data.priorStoragePath).toBe("visit/r1.pdf");
    expect(fx.removed).toEqual([]);
  });

  it("still writes the critical-value audit row, flagged outcome_replayed", async () => {
    fx.rpc = async () => {
      throw new Error("fetch failed");
    };
    fx.probe = { data: { id: "am-1" }, error: null };
    const out = await commitResultEdit(args());
    if (!out.ok) throw new Error(out.error);

    await auditAlertChanges(out.data, {
      actorId: "u1",
      patientId: "pt1",
      resultId: "r1",
      testRequestIds: ["t1", "t2"],
      ip: null,
      ua: null,
    });

    expect(fx.audits).toHaveLength(1);
    expect(fx.audits[0].action).toBe("result.critical_value_detected");
    const meta = fx.audits[0].metadata as Record<string, unknown>;
    expect(meta.outcome_replayed).toBe(true);
    expect(meta.source).toBe("edit");
    expect(meta.test_request_ids).toEqual(["t1", "t2"]);
    expect((meta.alerts as unknown[]).length).toBe(1);
  });

  it("takes the RPC's own replay answer (a retried attempt that already committed)", async () => {
    fx.rpc = async () => ({
      data: { replayed: true, amendment_seq: 1, prior_storage_path: "visit/r1.pdf" },
      error: null,
    });
    const out = await commitResultEdit(args());
    expect(out.ok && out.data.replayed).toBe(true);
    expect(out.ok && out.data.alertsAdded).toEqual([ALERT]);
  });

  it("a normal commit is not a replay and reports only the alerts the database added", async () => {
    fx.rpc = async () => ({
      data: { replayed: false, amendment_seq: 1, prior_storage_path: "visit/r1.pdf", alerts_added: [] },
      error: null,
    });
    const out = await commitResultEdit(args());
    expect(out.ok && out.data.replayed).toBe(false);
    expect(out.ok && out.data.alertsAdded).toEqual([]);
  });

  it("keeps the uploaded PDF and asks for a reload when neither the RPC nor the probe can answer", async () => {
    fx.rpc = async () => {
      throw new Error("fetch failed");
    };
    fx.probe = { data: null, error: { message: "timeout" } };
    const out = await commitResultEdit(args());
    expect(out).toEqual({ ok: false, error: UNCONFIRMED_SAVE_ERROR });
    expect(fx.removed).toEqual([]);
  });

  it("keeps the PDF when the answer is lost and the probe says it did NOT commit (the call may still be in flight)", async () => {
    fx.rpc = async () => ({ data: null, error: { code: null, message: "network" } });
    fx.probe = { data: null, error: null };
    const out = await commitResultEdit(args());
    expect(out).toEqual({ ok: false, error: UNCONFIRMED_SAVE_ERROR });
    expect(fx.removed).toEqual([]);
  });
});

describe("commitResultEdit — a definite rejection", () => {
  it("removes exactly this attempt's upload once the probe confirms nothing committed", async () => {
    fx.rpc = async () => ({ data: null, error: { code: "P0065", message: "stale" } });
    fx.probe = { data: null, error: null };
    const out = await commitResultEdit(args());
    expect(out.ok).toBe(false);
    expect(fx.uploads).toHaveLength(1);
    expect(fx.removed).toEqual([{ bucket: "results", paths: [fx.uploads[0].path] }]);
  });

  it("never removes anything when the probe finds the attempt committed after all [R1]", async () => {
    fx.rpc = async () => ({ data: null, error: { code: "P0066", message: "not editable" } });
    fx.probe = { data: { id: "am-1" }, error: null };
    const out = await commitResultEdit(args());
    expect(out.ok && out.data.replayed).toBe(true);
    expect(fx.removed).toEqual([]);
  });

  it("keeps the upload when rejected but the probe could not run", async () => {
    fx.rpc = async () => ({ data: null, error: { code: "P0065", message: "stale" } });
    fx.probe = { data: null, error: { message: "timeout" } };
    const out = await commitResultEdit(args());
    expect(out.ok).toBe(false);
    expect(fx.removed).toEqual([]);
  });
});
