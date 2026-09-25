"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { manilaRangeUtc } from "@/lib/dates/manila";
import {
  isActivePatient,
  PATIENT_LIFECYCLE_COLUMNS,
  type PatientLifecycle,
} from "@/lib/patients/active";

export type ClosureResult = { ok: true } | { ok: false; error: string };
export type BulkRescheduleResult =
  | { ok: true; affected: number; skipped: number }
  | { ok: false; error: string };

interface RescheduleCandidate {
  id: string;
  patient_id: string | null;
  patients: PatientLifecycle | PatientLifecycle[] | null;
}

const ClosureSchema = z.object({
  closed_on: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD."),
  reason: z.string().trim().min(1, "Reason is required.").max(200),
});

export async function createClosureAction(
  _prev: ClosureResult | null,
  formData: FormData,
): Promise<ClosureResult> {
  const session = await requireAdminStaff();
  const parsed = ClosureSchema.safeParse({
    closed_on: formData.get("closed_on"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("clinic_closures").insert({
    closed_on: parsed.data.closed_on,
    reason: parsed.data.reason,
    created_by: session.user_id,
  });
  if (error) {
    if (error.code === "23505") {
      return {
        ok: false,
        error: "That date is already marked as a closure.",
      };
    }
    return { ok: false, error: error.message };
  }

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "closure.created",
    resource_type: "clinic_closure",
    // clinic_closures uses the date as its primary key; audit_log.resource_id
    // is uuid, so the date lives in metadata.
    resource_id: null,
    metadata: {
      closed_on: parsed.data.closed_on,
      reason: parsed.data.reason,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/admin/closures");
  return { ok: true };
}

// Move every confirmed / scheduled appointment on the given closure
// date to pending_callback so reception can reach out and propose a
// new slot. Only touches appointments with a real scheduled_at on that
// Manila day; pending_callback rows are already in the right state.
//
// A closure can be recorded for a PAST date after a patient whose (then
// past, non-blocking) appointment fell on that day was deleted — the
// reschedule must not reopen work on a deleted/merged record by turning a
// closed appointment into an open pending_callback. Candidates are SELECTed
// first with the patient's lifecycle columns embedded so `isActivePatient`
// can filter in JS: PostgREST silently ignores a filter aimed at a
// LEFT-joined embed (`patients` here — a walk-in appointment has
// patient_id = null and must still be rescheduled), so this can't be a
// `.eq()`/`.is()` on the query itself. One inactive patient never blocks the
// whole action — that row is skipped and the skipped count is reported both
// in the result and in the closure-level audit metadata.
export async function bulkRescheduleForClosureAction(
  _prev: BulkRescheduleResult | null,
  formData: FormData,
): Promise<BulkRescheduleResult> {
  const session = await requireAdminStaff();
  const closedOn = String(formData.get("closed_on") ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(closedOn)) {
    return { ok: false, error: "Invalid date." };
  }

  // Verify the closure exists — guards against a stale form replaying
  // after the closure was deleted.
  const supabase = await createClient();
  const { data: closure } = await supabase
    .from("clinic_closures")
    .select("closed_on")
    .eq("closed_on", closedOn)
    .maybeSingle();
  if (!closure) {
    return { ok: false, error: "Closure no longer exists." };
  }

  // Manila-day bounds: [date 00:00 PHT, next-date 00:00 PHT).
  const { fromIso: startIso, toIso: endIso } = manilaRangeUtc(closedOn, closedOn);
  if (!startIso || !endIso) {
    return { ok: false, error: "Invalid date." };
  }

  const admin = createAdminClient();
  const { data: candidates, error: selectError } = await admin
    .from("appointments")
    .select(`id, patient_id, patients ( ${PATIENT_LIFECYCLE_COLUMNS} )`)
    .gte("scheduled_at", startIso)
    .lt("scheduled_at", endIso)
    .in("status", ["confirmed", "arrived"])
    .returns<RescheduleCandidate[]>();
  if (selectError) return { ok: false, error: selectError.message };

  let skipped = 0;
  const rows: RescheduleCandidate[] = [];
  for (const r of candidates ?? []) {
    const patient = Array.isArray(r.patients) ? (r.patients[0] ?? null) : r.patients;
    // Walk-ins (patient_id null, no embedded patient) always reschedule.
    if (patient === null || isActivePatient(patient)) {
      rows.push(r);
    } else {
      skipped++;
    }
  }

  if (rows.length > 0) {
    const { error: updateError } = await admin
      .from("appointments")
      .update({ status: "pending_callback", scheduled_at: null })
      .in(
        "id",
        rows.map((r) => r.id),
      );
    if (updateError) return { ok: false, error: updateError.message };
  }

  // One audit row per RESCHEDULED appointment so the trail is searchable
  // by patient — skipped rows are not touched, so they get no per-row audit
  // row. Also one summary row at the closure level.
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ua = h.get("user-agent");
  for (const r of rows) {
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      patient_id: r.patient_id ?? null,
      action: "appointment.bulk_rescheduled_for_closure",
      resource_type: "appointment",
      resource_id: r.id,
      metadata: {
        closed_on: closedOn,
        previous_status: "confirmed_or_arrived",
        new_status: "pending_callback",
      },
      ip_address: ip,
      user_agent: ua,
    });
  }
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "closure.bulk_rescheduled",
    resource_type: "clinic_closure",
    resource_id: null,
    metadata: { closed_on: closedOn, affected: rows.length, skipped },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath("/staff/admin/closures");
  revalidatePath("/staff/appointments");
  return { ok: true, affected: rows.length, skipped };
}

export async function deleteClosureAction(
  _prev: ClosureResult | null,
  formData: FormData,
): Promise<ClosureResult> {
  const session = await requireAdminStaff();
  const closedOn = String(formData.get("closed_on") ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(closedOn)) {
    return { ok: false, error: "Invalid date." };
  }

  const supabase = await createClient();
  const { data: existing, error: readErr } = await supabase
    .from("clinic_closures")
    .select("closed_on, reason")
    .eq("closed_on", closedOn)
    .maybeSingle();
  if (readErr || !existing) {
    return { ok: false, error: "Closure not found." };
  }

  const { error } = await supabase
    .from("clinic_closures")
    .delete()
    .eq("closed_on", closedOn);
  if (error) return { ok: false, error: error.message };

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "closure.deleted",
    resource_type: "clinic_closure",
    resource_id: null,
    metadata: { closed_on: closedOn, reason: existing.reason },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/admin/closures");
  return { ok: true };
}
