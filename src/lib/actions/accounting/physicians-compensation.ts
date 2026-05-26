"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { audit } from "@/lib/audit/log";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { CompensationArrangementSchema } from "@/lib/validations/accounting";

type ActionResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export async function updateCompensationArrangement(input: {
  physician_id: string;
  compensation_arrangement: "pf_split" | "rent_paying" | "shareholder";
}): Promise<ActionResult<{ updated: true }>> {
  const staff = await requireAdminStaff();
  const parsed = CompensationArrangementSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const admin = createAdminClient();

  const { data: before } = await admin
    .from("physicians")
    .select("compensation_arrangement")
    .eq("id", input.physician_id)
    .single();

  const { error } = await admin
    .from("physicians")
    .update({ compensation_arrangement: input.compensation_arrangement })
    .eq("id", input.physician_id);
  if (error) return { ok: false, error: translatePgError(error) };

  await audit({
    actor_id: staff.user_id,
    actor_type: "staff",
    action: "physician.compensation_arrangement_updated",
    resource_type: "physicians",
    resource_id: input.physician_id,
    metadata: { before: before?.compensation_arrangement, after: input.compensation_arrangement },
  });

  return { ok: true, data: { updated: true } };
}

export async function recomputeClinicFeeForUnreleased(): Promise<
  ActionResult<{ rows_affected: number }>
> {
  const staff = await requireAdminStaff();
  const admin = createAdminClient();

  // See spec §3.5 — admin-triggered scrub. Only touches unreleased tests (those
  // without a posted JE). Sets clinic_fee_php=0 + doctor_pf_php=final for
  // rent_paying / shareholder physicians.
  //
  // The RPC type is generated after migration 0065; until `npm run db:types`
  // is re-run the function name is unknown to the typed client. We call the
  // underlying query builder directly so there is no unsafe cast needed.
  const rpcName = "recompute_clinic_fee_for_unreleased" as Parameters<typeof admin.rpc>[0];
  const { data, error } = await admin.rpc(rpcName);
  if (error) return { ok: false, error: translatePgError(error) };

  const rowsAffected = (data as unknown as { rows_affected: number })?.rows_affected ?? 0;

  // Per spec §3.5: audit metadata includes the count of physicians whose
  // arrangement governs the scrub. Useful for reading the audit log without
  // having to re-query the physicians table.
  const { count: physiciansClassified } = await admin
    .from("physicians")
    .select("id", { count: "exact", head: true })
    .in("compensation_arrangement", ["rent_paying", "shareholder"]);

  await audit({
    actor_id: staff.user_id,
    actor_type: "staff",
    action: "pf.clinic_fee_scrub_run",
    resource_type: "test_requests",
    resource_id: null,
    metadata: {
      rows_affected: rowsAffected,
      physicians_classified: physiciansClassified ?? 0,
    },
  });

  return { ok: true, data: { rows_affected: rowsAffected } };
}
