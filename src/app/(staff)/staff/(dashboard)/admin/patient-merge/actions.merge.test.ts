// Wiring only: the merge and undo themselves are proven in SQL
// (supabase/tests/0196_patient_merge_atomic_smoke.sql, scripts/merge-concurrency-proof.ts).
// Pins that the actions send the right RPC arguments, retry once on a lock
// race, translate refusals, never touch a table directly, and record the
// notice email in its own audit row.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const K = "11111111-1111-4111-8111-111111111111";
const S = "22222222-2222-4222-8222-222222222222";
const M = "33333333-3333-4333-8333-333333333333";

const fx = vi.hoisted(() => ({
  rpcCalls: [] as { fn: string; args: Record<string, unknown> }[],
  rpcResults: [] as { data: unknown; error: { code?: string; message: string } | null }[],
  fromCalls: [] as string[],
  audits: [] as Record<string, unknown>[],
  emails: [] as Record<string, unknown>[],
  recipient: { kind: "active", patient: { email: "ana@example.com" } } as Record<string, unknown>,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/server/action-helpers", () => ({ ipAndAgent: async () => ({ ip: "203.0.113.9", ua: "vitest" }) }));
vi.mock("@/lib/auth/require-admin", () => ({
  requireAdminStaff: async () => ({ user_id: "admin-1", email: "", full_name: "Admin", role: "admin" }),
}));
vi.mock("@/lib/audit/log", () => ({ audit: async (e: Record<string, unknown>) => void fx.audits.push(e) }));
vi.mock("@/lib/observability/report-error", () => ({ reportError: async () => {} }));
vi.mock("@/lib/notifications/email", () => ({
  sendEmail: async (e: Record<string, unknown>) => {
    fx.emails.push(e);
    return { ok: true, id: "email-1" };
  },
}));
vi.mock("@/lib/notifications/active-patient-recipient", () => ({ checkPatientRecipient: async () => fx.recipient }));
vi.mock("@/lib/notifications/inactive-recipient-audit", () => ({ auditSkippedInactiveRecipient: async () => {} }));
vi.mock("@/lib/notifications/branded-email", () => ({
  renderEmailShell: () => "", emailParagraph: () => "", emailHighlight: () => "", escapeHtml: (s: string) => s,
}));
vi.mock("@/lib/patients/active", () => ({ activePatients: (q: unknown) => q }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      fx.rpcCalls.push({ fn, args });
      return fx.rpcResults.shift() ?? { data: null, error: { message: "no scripted result" } };
    },
    from: (table: string) => {
      fx.fromCalls.push(table);
      // Only the notice email's first-name read may touch a table.
      const q = {
        select: () => q, eq: () => q,
        maybeSingle: async () => ({ data: { first_name: "Ana" }, error: null }),
      };
      return q;
    },
  }),
}));

import { mergePatientsAction, undoMergeAction } from "./actions";

const MERGED = {
  merge_id: M, keep_id: K, source_id: S, kept_drm_id: "DRM-0001", merged_drm_id: "DRM-0002",
  moved: { visits: 2, appointments: 1, audit_log: 3, critical_alerts: 0, patient_consents: 1, appointment_attachments: 0 },
  filled: ["phone"], rechained: 0,
};

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  fx.rpcCalls = []; fx.rpcResults = []; fx.fromCalls = []; fx.audits = []; fx.emails = [];
  fx.recipient = { kind: "active", patient: { email: "ana@example.com" } };
});

describe("mergePatientsAction", () => {
  it("calls merge_patients_guarded once with actor + context and returns the summary", async () => {
    fx.rpcResults.push({ data: MERGED, error: null });
    const res = await mergePatientsAction(null, form({ keep_id: K, source_id: S, confirm: "MERGE" }));
    expect(fx.rpcCalls).toEqual([{
      fn: "merge_patients_guarded",
      args: { p_keep: K, p_source: S, p_actor: "admin-1", p_context: { ip: "203.0.113.9", user_agent: "vitest", source: "admin" } },
    }]);
    expect(res).toMatchObject({ ok: true, kept_drm_id: "DRM-0001", merged_drm_id: "DRM-0002", filled: ["phone"], rechained: 0 });
    expect(fx.fromCalls.filter((t) => t !== "patients")).toEqual([]);
  });

  it("marks a candidates-page merge with source=candidates", async () => {
    fx.rpcResults.push({ data: MERGED, error: null });
    await mergePatientsAction(null, form({ keep_id: K, source_id: S, confirm: "MERGE", origin: "candidates" }));
    expect((fx.rpcCalls[0]!.args.p_context as Record<string, unknown>).source).toBe("candidates");
  });

  it("retries exactly once on a lock race (P0072), then succeeds", async () => {
    fx.rpcResults.push({ data: null, error: { code: "P0072", message: "changed" } }, { data: MERGED, error: null });
    const res = await mergePatientsAction(null, form({ keep_id: K, source_id: S, confirm: "MERGE" }));
    expect(fx.rpcCalls).toHaveLength(2);
    expect(res.ok).toBe(true);
  });

  it("translates a refusal and sends nothing", async () => {
    fx.rpcResults.push({ data: null, error: { code: "P0058", message: "DRM-0002 is deleted — restore it first" } });
    const res = await mergePatientsAction(null, form({ keep_id: K, source_id: S, confirm: "MERGE" }));
    expect(res).toEqual({ ok: false, error: "DRM-0002 is deleted — restore it first" });
    expect(fx.emails).toEqual([]);
    expect(fx.audits).toEqual([]);
  });

  it("refuses without calling the database when the confirmation or pair is wrong", async () => {
    expect((await mergePatientsAction(null, form({ keep_id: K, source_id: S, confirm: "merge" }))).ok).toBe(false);
    expect((await mergePatientsAction(null, form({ keep_id: K, source_id: K, confirm: "MERGE" }))).ok).toBe(false);
    expect(fx.rpcCalls).toEqual([]);
  });

  it("emails the kept record and records the notice in its own audit row", async () => {
    fx.rpcResults.push({ data: MERGED, error: null });
    await mergePatientsAction(null, form({ keep_id: K, source_id: S, confirm: "MERGE" }));
    expect(fx.emails).toHaveLength(1);
    expect(fx.emails[0]!.to).toBe("ana@example.com");
    expect(fx.audits).toEqual([expect.objectContaining({
      action: "patient.merge.notified", patient_id: K, resource_id: K, actor_id: "admin-1",
      metadata: expect.objectContaining({ merge_id: M, recipient: "active" }),
    })]);
  });

  it("does not email an inactive kept record but still audits the skip", async () => {
    fx.recipient = { kind: "inactive", reason: "deleted" };
    fx.rpcResults.push({ data: MERGED, error: null });
    await mergePatientsAction(null, form({ keep_id: K, source_id: S, confirm: "MERGE" }));
    expect(fx.emails).toEqual([]);
    expect(fx.audits[0]).toMatchObject({ action: "patient.merge.notified", metadata: expect.objectContaining({ recipient: "inactive" }) });
  });
});

describe("undoMergeAction", () => {
  const REPORT = {
    merge_id: M, keep_id: K, source_id: S, kept_drm_id: "DRM-0001", source_drm_id: "DRM-0002",
    resumed_interrupted_undo: false,
    moved_back: { visits: 2, appointments: 0, audit_log: 0, critical_alerts: 0, patient_consents: 0, appointment_attachments: 0 },
    left_on_keep: { visits: [], appointments: [], audit_log: [], critical_alerts: [], patient_consents: [], appointment_attachments: [] },
    kept_fields: ["phone"], reverted_fields: [], rechained_back: 0,
  };

  it("calls undo_patient_merge_guarded and returns the plain-language report", async () => {
    fx.rpcResults.push({ data: REPORT, error: null });
    const res = await undoMergeAction(null, form({ merge_id: M }));
    expect(fx.rpcCalls).toEqual([{
      fn: "undo_patient_merge_guarded",
      args: { p_merge_id: M, p_actor: "admin-1", p_context: { ip: "203.0.113.9", user_agent: "vitest" } },
    }]);
    expect(res).toEqual({
      ok: true,
      lines: ["Moved back to DRM-0002: 2 visits.", "Kept on DRM-0001 because they were edited after the merge: phone."],
    });
    expect(fx.fromCalls).toEqual([]);
  });

  it("translates a refusal (P0079 passes the SQL's words through)", async () => {
    fx.rpcResults.push({ data: null, error: { code: "P0079", message: "merges can only be undone within 30 days" } });
    expect(await undoMergeAction(null, form({ merge_id: M }))).toEqual({
      ok: false, error: "Merges can only be undone within 30 days.",
    });
  });

  it("rejects a malformed id without calling the database", async () => {
    expect((await undoMergeAction(null, form({ merge_id: "nope" }))).ok).toBe(false);
    expect(fx.rpcCalls).toEqual([]);
  });
});
