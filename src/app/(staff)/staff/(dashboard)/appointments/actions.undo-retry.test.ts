import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * undoBulkAppointmentsAction's bucket write, against the in-memory fake client
 * (src/lib/testing/fake-db). Only the edges are stubbed (session, audit,
 * headers/cache, the patient-active guard): the real Undo planning, batch-row
 * loading and conditional UPDATE all run, and the tests read the rows back.
 *
 * Pins the retry: a write that loses a patient-lifecycle race (P0072) is tried
 * once more, like the forward bulk path and #263; a second loss lands the
 * booking in notRestored with the existing "try again" reason.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "9.9.9.9", "user-agent": "vitest" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const h = vi.hoisted(() => ({
  session: { user_id: "user-admin", role: "admin" } as { user_id: string; role: string },
  db: null as unknown,
  audit: vi.fn(async (entry: Record<string, unknown>) => void entry),
}));

vi.mock("@/lib/auth/require-staff", () => ({ requireActiveStaff: async () => h.session }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => (h.db as FakeDb).client() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => (h.db as FakeDb).client() }));
vi.mock("@/lib/audit/log", () => ({ audit: h.audit }));
vi.mock("@/lib/patients/require-active", () => ({
  assertAppointmentsPatientsActive: async () => ({ ok: true }),
}));

import { undoBulkAppointmentsAction } from "./actions";
import { FakeDb, type Row } from "@/lib/testing/fake-db";

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const BATCH = "0b7c3d2e-1111-4111-8111-000000000002";
const APPT = "appt-1";
const TRY_AGAIN = "could not be undone just now — try again";

let db: FakeDb;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  h.audit.mockClear();
  db = new FakeDb();
  db.seed("patients", [{ id: "patient-1", deleted_at: null, merged_into_id: null }]);
  db.seed("appointments", [{ id: APPT, patient_id: "patient-1", status: "cancelled" }]);
  db.seed("audit_log", [
    {
      id: "a-00001",
      actor_id: h.session.user_id,
      resource_type: "appointment",
      resource_id: APPT,
      action: "appointment.cancelled",
      metadata: { bulk_batch_id: BATCH, previous_status: "confirmed", group_appointment_ids: [APPT] },
      created_at: new Date(NOW - 120_000).toISOString(),
    } satisfies Row,
  ]);
  h.db = db;
});

afterEach(() => {
  vi.useRealTimers();
});

/** Fail the appointments UPDATE with P0072 for its first `n` attempts. */
function loseRaceTimes(n: number) {
  let seen = 0;
  db.hooks.beforeWrite = (call) => {
    if (call.table !== "appointments") return;
    seen += 1;
    if (seen <= n) return { code: "P0072", message: "moved" };
  };
}

describe("undoBulkAppointmentsAction — bucket write retry", () => {
  it("retries once when the write loses a lifecycle race, then restores the booking", async () => {
    loseRaceTimes(1);
    const res = await undoBulkAppointmentsAction({ batchId: BATCH });
    expect(res).toEqual({ ok: true, restoredIds: [APPT], notRestored: [] });
    expect(db.row("appointments", APPT).status).toBe("confirmed");
    expect(db.updates("appointments")).toHaveLength(2);
  });

  it("reports the booking as not restored when the retry loses the race too", async () => {
    // A second booking in another bucket proceeds, so the call is ok:true with a named miss.
    db.seed("appointments", [{ id: "appt-2", patient_id: "patient-1", status: "no_show" }]);
    db.seed("audit_log", [
      {
        id: "a-00002",
        actor_id: h.session.user_id,
        resource_type: "appointment",
        resource_id: "appt-2",
        action: "appointment.no_show",
        metadata: { bulk_batch_id: BATCH, previous_status: "confirmed", group_appointment_ids: ["appt-2"] },
        created_at: new Date(NOW - 119_000).toISOString(),
      },
    ]);
    let seen = 0;
    db.hooks.beforeWrite = (call) => {
      if (call.table !== "appointments") return;
      // Only the cancelled bucket loses, on both attempts.
      if ((call.filters.find(([n, a]) => n === "eq" && a[0] === "status")?.[1] ?? [])[1] === "cancelled") {
        seen += 1;
        return { code: "P0072", message: "moved" };
      }
    };
    const res = await undoBulkAppointmentsAction({ batchId: BATCH });
    expect(seen).toBe(2);
    expect(res).toEqual({
      ok: true,
      restoredIds: ["appt-2"],
      notRestored: [{ id: APPT, reason: TRY_AGAIN }],
    });
    expect(db.row("appointments", APPT).status).toBe("cancelled");
    expect(db.row("appointments", "appt-2").status).toBe("confirmed");
  });

  it("fails the whole call when the only write loses the race twice", async () => {
    loseRaceTimes(2);
    const res = await undoBulkAppointmentsAction({ batchId: BATCH });
    expect(res).toEqual({ ok: false, error: "Could not undo — refresh the page and check the bookings." });
    expect(db.row("appointments", APPT).status).toBe("cancelled");
    expect(db.updates("appointments")).toHaveLength(2);
  });
});
