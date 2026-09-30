import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Wiring coverage for mergePatientsAction's post-move failure paths (0184
 * review follow-up): the fill-field write and the tombstone write both run
 * AFTER all six FK-table moves have already landed, so a failure there must
 * roll those six moves back — not just return an error and suggest a re-run,
 * which would write an EMPTY undo ledger on the next attempt (the moves are
 * no-ops the second time) and leave Undo with nothing to restore.
 *
 * The pure rollback mechanics (ordering, the snapshot-vs-lost-response case,
 * partial rollback failure reporting) are covered exhaustively in
 * src/lib/patients/merge-steps.test.ts; this file only pins that
 * mergePatientsAction actually WIRES a full six-table rollback into both the
 * fill-failure and the tombstone-failure branch.
 *
 * The admin client is faked table-by-table, the shape used in
 * src/lib/actions/accounting/post-till-cash-expense.test.ts.
 */

vi.mock("server-only", () => ({}));

const KEEP_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ID = "22222222-2222-4222-8222-222222222222";

const FK_TABLES = [
  "visits",
  "appointments",
  "audit_log",
  "critical_alerts",
  "patient_consents",
  "appointment_attachments",
] as const;

const fx = vi.hoisted(() => ({
  keep: {
    id: "11111111-1111-4111-8111-111111111111",
    drm_id: "DRM-0001",
    first_name: "Ana",
    last_name: "Cruz",
    middle_name: null as string | null,
    sex: null as string | null,
    phone: null as string | null,
    email: null as string | null,
    address: null as string | null,
    merged_into_id: null as string | null,
    deleted_at: null as string | null,
  },
  source: {
    id: "22222222-2222-4222-8222-222222222222",
    drm_id: "DRM-0002",
    first_name: "Ana",
    last_name: "Cruz",
    middle_name: "Reyes" as string | null,
    sex: "F" as string | null,
    phone: "09171234567" as string | null,
    email: "ana@example.com" as string | null,
    address: "Manila" as string | null,
    merged_into_id: null as string | null,
    deleted_at: null as string | null,
  },
  // One snapshot/forward-move id per FK table (audit_log's is numeric —
  // bigserial, not uuid — same as production).
  ids: {
    visits: "visits-1",
    appointments: "appointments-1",
    audit_log: 501,
    critical_alerts: "critical_alerts-1",
    patient_consents: "patient_consents-1",
    appointment_attachments: "appointment_attachments-1",
  } as Record<string, unknown>,
  fillError: null as { message: string } | null,
  tombstoneError: null as { message: string } | null,
  rollbackError: null as { message: string } | null,
  fillCalls: [] as Record<string, unknown>[],
  tombstoneCalls: [] as Record<string, unknown>[],
  rollbackCalls: [] as { table: string; ids: unknown[] }[],
  reported: [] as Record<string, unknown>[],
}));

function fkTable(table: string) {
  // `q` doubles as both a chainable builder AND (only for the rollback
  // shape: update().in().eq(), nothing further) a thenable — real
  // supabase-js query builders work the same way.
  const q: {
    _update: Record<string, unknown> | null;
    _in: unknown[] | null;
    select: () => unknown;
    eq: () => typeof q;
    order: () => typeof q;
    in: (col: string, vals: unknown[]) => typeof q;
    range: () => Promise<{ data: { id: unknown }[]; error: null }>;
    update: (payload: Record<string, unknown>) => typeof q;
    then: (resolve: (v: { error: { message: string } | null }) => void) => void;
  } = {
    _update: null,
    _in: null,
    select: () => {
      if (q._update) {
        // Forward-move terminal: update({patient_id: keep}).eq(...).select("id").
        return Promise.resolve({ data: [{ id: fx.ids[table] }], error: null });
      }
      return q;
    },
    eq: () => q,
    order: () => q,
    in: (_col, vals) => {
      q._in = vals;
      return q;
    },
    range: async () => ({ data: [{ id: fx.ids[table] }], error: null }),
    update: (payload) => {
      q._update = payload;
      return q;
    },
    then: (resolve) => {
      // Only the rollback shape (update().in().eq(), bare-awaited) reaches
      // here — the forward move resolves via `.select()` above, and the
      // snapshot read via `.range()`.
      fx.rollbackCalls.push({ table, ids: q._in ?? [] });
      resolve({ error: fx.rollbackError });
    },
  };
  return q;
}

function patientsTable() {
  const q: {
    _update: Record<string, unknown> | null;
    select: () => typeof q;
    in: () => Promise<{ data: (typeof fx.keep)[]; error: null }>;
    update: (payload: Record<string, unknown>) => typeof q;
    eq: () => Promise<{ error: { message: string } | null }>;
  } = {
    _update: null,
    select: () => q,
    in: () => Promise.resolve({ data: [fx.keep, fx.source], error: null }),
    update: (payload) => {
      q._update = payload;
      return q;
    },
    eq: () => {
      if (q._update && "merged_into_id" in q._update) {
        fx.tombstoneCalls.push(q._update);
        return Promise.resolve({ error: fx.tombstoneError });
      }
      fx.fillCalls.push(q._update ?? {});
      return Promise.resolve({ error: fx.fillError });
    },
  };
  return q;
}

vi.mock("next/headers", () => ({ headers: async () => new Map<string, string>() }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth/require-admin", () => ({
  requireAdminStaff: async () => ({ user_id: "admin-1", email: "", full_name: "Admin", role: "admin" }),
}));
vi.mock("@/lib/audit/log", () => ({ audit: async () => {} }));
vi.mock("@/lib/observability/report-error", () => ({
  reportError: async (e: Record<string, unknown>) => {
    fx.reported.push(e);
  },
}));
vi.mock("@/lib/notifications/email", () => ({ sendEmail: async () => ({ ok: true, id: "email-1" }) }));
vi.mock("@/lib/notifications/active-patient-recipient", () => ({
  checkPatientRecipient: async () => ({ kind: "inactive", reason: "unreached" }),
}));
vi.mock("@/lib/notifications/inactive-recipient-audit", () => ({
  auditSkippedInactiveRecipient: async () => {},
}));
vi.mock("@/lib/notifications/branded-email", () => ({
  renderEmailShell: () => "",
  emailParagraph: () => "",
  emailHighlight: () => "",
  escapeHtml: (s: string) => s,
}));
vi.mock("@/lib/patients/active", () => ({ activePatients: (q: unknown) => q }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table === "patients") return patientsTable();
      if ((FK_TABLES as readonly string[]).includes(table)) return fkTable(table);
      throw new Error(`unexpected table in test: ${table}`);
    },
  }),
}));

const { mergePatientsAction } = await import("./actions");

function mergeForm() {
  const fd = new FormData();
  fd.set("keep_id", KEEP_ID);
  fd.set("source_id", SOURCE_ID);
  fd.set("confirm", "MERGE");
  return fd;
}

beforeEach(() => {
  fx.fillError = null;
  fx.tombstoneError = null;
  fx.rollbackError = null;
  fx.fillCalls.length = 0;
  fx.tombstoneCalls.length = 0;
  fx.rollbackCalls.length = 0;
  fx.reported.length = 0;
  // Reset keep to "fillable" (nulls) by default; the tombstone-only test
  // overrides this so the fill step is skipped entirely (fill = {}).
  fx.keep.middle_name = null;
  fx.keep.sex = null;
  fx.keep.phone = null;
  fx.keep.email = null;
  fx.keep.address = null;
});

describe("mergePatientsAction — fill-write failure rolls back all six moves", () => {
  it("rolls every FK table back to source_id, in forward order, and reports 'nothing was changed'", async () => {
    fx.fillError = { message: "fill boom" };
    const result = await mergePatientsAction(null, mergeForm());

    expect(result).toEqual({
      ok: false,
      error:
        "The merge couldn't finish because another change was being saved at the same moment. Nothing was changed — please try again.",
    });
    expect(fx.fillCalls).toHaveLength(1);
    // Never reached the tombstone.
    expect(fx.tombstoneCalls).toHaveLength(0);
    // All six FK tables were rolled back, in forward order (visits before
    // critical_alerts — a_lifecycle_guard's (a2') check).
    expect(fx.rollbackCalls.map((c) => c.table)).toEqual(FK_TABLES as unknown as string[]);
    const visitsIdx = fx.rollbackCalls.findIndex((c) => c.table === "visits");
    const alertsIdx = fx.rollbackCalls.findIndex((c) => c.table === "critical_alerts");
    expect(visitsIdx).toBeLessThan(alertsIdx);
    // Each rollback used the exact id that table moved (via the forward-move
    // acknowledgement / snapshot union).
    for (const table of FK_TABLES) {
      const call = fx.rollbackCalls.find((c) => c.table === table)!;
      expect(call.ids).toContain(fx.ids[table]);
    }
    // Reported as an informational "recovered fully" case, not a rollback failure.
    expect(fx.reported).toHaveLength(1);
    expect(fx.reported[0]!.scope).toBe("mergePatientsAction:fill");
  });
});

describe("mergePatientsAction — tombstone-write failure rolls back all six moves", () => {
  it("rolls every FK table back to source_id and reports 'nothing was changed'", async () => {
    // Keep already has every fillable field, matching source — fill stays
    // empty ({}), so the tombstone write is reached directly.
    fx.keep.middle_name = "Reyes";
    fx.keep.sex = "F";
    fx.keep.phone = "09171234567";
    fx.keep.email = "ana@example.com";
    fx.keep.address = "Manila";
    fx.tombstoneError = { message: "tombstone boom" };

    const result = await mergePatientsAction(null, mergeForm());

    expect(result).toEqual({
      ok: false,
      error:
        "The merge couldn't finish because another change was being saved at the same moment. Nothing was changed — please try again.",
    });
    expect(fx.fillCalls).toHaveLength(0);
    expect(fx.tombstoneCalls).toHaveLength(1);
    expect(fx.rollbackCalls.map((c) => c.table)).toEqual(FK_TABLES as unknown as string[]);
    expect(fx.reported).toHaveLength(1);
    expect(fx.reported[0]!.scope).toBe("mergePatientsAction:tombstone");
  });

  it("when the rollback itself also fails, reports the exact stranded ids per table and refuses a re-run", async () => {
    fx.keep.middle_name = "Reyes";
    fx.keep.sex = "F";
    fx.keep.phone = "09171234567";
    fx.keep.email = "ana@example.com";
    fx.keep.address = "Manila";
    fx.tombstoneError = { message: "tombstone boom" };
    fx.rollbackError = { message: "rollback boom" };

    const result = await mergePatientsAction(null, mergeForm());

    expect(result).toEqual({
      ok: false,
      error:
        "The merge stopped part-way and some records could not be put back automatically. Don't run it again — the error has been reported for a manual fix.",
    });
    expect(fx.reported).toHaveLength(1);
    expect(fx.reported[0]!.scope).toBe("mergePatientsAction:tombstone:rollback");
    const metadata = fx.reported[0]!.metadata as { stranded_ids: Record<string, unknown[]> };
    for (const table of FK_TABLES) {
      expect(metadata.stranded_ids[table]).toContain(fx.ids[table]);
    }
  });
});
