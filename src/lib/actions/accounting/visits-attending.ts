"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { audit } from "@/lib/audit/log";
import { translatePgError } from "@/lib/accounting/pg-errors";
import {
  VisitAttendingSchema,
  TestRequestAttendingSchema,
} from "@/lib/validations/accounting";

type ActionResult<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

export async function setVisitAttendingPhysician(input: {
  visit_id: string;
  attending_physician_id: string | null;
}): Promise<ActionResult<{ updated: true }>> {
  const staff = await requireActiveStaff();  // reception or admin
  const parsed = VisitAttendingSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const admin = createAdminClient();

  const { data: before } = await admin
    .from("visits")
    .select("attending_physician_id")
    .eq("id", input.visit_id)
    .single();

  const { error } = await admin
    .from("visits")
    .update({ attending_physician_id: input.attending_physician_id })
    .eq("id", input.visit_id);
  if (error) return { ok: false, error: translatePgError(error) };

  await audit({
    actor_id: staff.user_id,
    actor_type: "staff",
    action: "visit.attending_physician_updated",
    resource_type: "visits",
    resource_id: input.visit_id,
    metadata: { before: before?.attending_physician_id, after: input.attending_physician_id },
  });
  return { ok: true, data: { updated: true } };
}

export async function setLineAttendingPhysician(input: {
  test_request_id: string;
  attending_physician_id: string | null;
}): Promise<ActionResult<{ updated: true }>> {
  const staff = await requireActiveStaff();
  const parsed = TestRequestAttendingSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const admin = createAdminClient();

  const { error } = await admin
    .from("test_requests")
    .update({ attending_physician_id: input.attending_physician_id })
    .eq("id", input.test_request_id);
  if (error) return { ok: false, error: translatePgError(error) };

  await audit({
    actor_id: staff.user_id,
    actor_type: "staff",
    action: "visit.attending_physician_updated",
    resource_type: "test_requests",
    resource_id: input.test_request_id,
    metadata: { after: input.attending_physician_id },
  });
  return { ok: true, data: { updated: true } };
}
