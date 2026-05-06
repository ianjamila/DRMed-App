"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import {
  OverrideSchema,
  ScheduleBlockSchema,
} from "@/lib/validations/physician";

export type ScheduleResult = { ok: true } | { ok: false; error: string };

async function ipAndAgent() {
  const h = await headers();
  return {
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    ua: h.get("user-agent"),
  };
}

export async function addBlockAction(
  physicianId: string,
  _prev: ScheduleResult | null,
  formData: FormData,
): Promise<ScheduleResult> {
  const session = await requireAdminStaff();

  const parsed = ScheduleBlockSchema.safeParse({
    day_of_week: formData.get("day_of_week"),
    start_time: formData.get("start_time"),
    end_time: formData.get("end_time"),
    valid_from: formData.get("valid_from"),
    valid_until: formData.get("valid_until"),
    notes: formData.get("notes"),
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("physician_schedules")
    .insert({
      physician_id: physicianId,
      day_of_week: parsed.data.day_of_week,
      start_time: parsed.data.start_time,
      end_time: parsed.data.end_time,
      valid_from: parsed.data.valid_from ?? undefined,
      valid_until: parsed.data.valid_until,
      notes: parsed.data.notes,
    })
    .select("id")
    .single();
  if (error || !data) {
    return { ok: false, error: error?.message ?? "Could not add block." };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "physician.schedule_block_added",
    resource_type: "physician_schedule",
    resource_id: data.id,
    metadata: {
      physician_id: physicianId,
      day_of_week: parsed.data.day_of_week,
      start_time: parsed.data.start_time,
      end_time: parsed.data.end_time,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(`/staff/admin/physicians/${physicianId}/schedule`);
  return { ok: true };
}

export async function deleteBlockAction(
  physicianId: string,
  blockId: string,
): Promise<ScheduleResult> {
  const session = await requireAdminStaff();
  const admin = createAdminClient();

  const { error } = await admin
    .from("physician_schedules")
    .delete()
    .eq("id", blockId)
    .eq("physician_id", physicianId);
  if (error) return { ok: false, error: error.message };

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "physician.schedule_block_deleted",
    resource_type: "physician_schedule",
    resource_id: blockId,
    metadata: { physician_id: physicianId },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(`/staff/admin/physicians/${physicianId}/schedule`);
  return { ok: true };
}

export async function addOverrideAction(
  physicianId: string,
  _prev: ScheduleResult | null,
  formData: FormData,
): Promise<ScheduleResult> {
  const session = await requireAdminStaff();

  const parsed = OverrideSchema.safeParse({
    override_on: formData.get("override_on"),
    start_time: formData.get("start_time"),
    end_time: formData.get("end_time"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("physician_schedule_overrides")
    .insert({
      physician_id: physicianId,
      override_on: parsed.data.override_on,
      start_time: parsed.data.start_time,
      end_time: parsed.data.end_time,
      reason: parsed.data.reason,
    })
    .select("id")
    .single();
  if (error || !data) {
    return { ok: false, error: error?.message ?? "Could not add override." };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "physician.schedule_override_added",
    resource_type: "physician_schedule_override",
    resource_id: data.id,
    metadata: {
      physician_id: physicianId,
      override_on: parsed.data.override_on,
      full_day: parsed.data.start_time === null,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(`/staff/admin/physicians/${physicianId}/schedule`);
  return { ok: true };
}

export async function deleteOverrideAction(
  physicianId: string,
  overrideId: string,
): Promise<ScheduleResult> {
  const session = await requireAdminStaff();
  const admin = createAdminClient();

  const { error } = await admin
    .from("physician_schedule_overrides")
    .delete()
    .eq("id", overrideId)
    .eq("physician_id", physicianId);
  if (error) return { ok: false, error: error.message };

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "physician.schedule_override_deleted",
    resource_type: "physician_schedule_override",
    resource_id: overrideId,
    metadata: { physician_id: physicianId },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(`/staff/admin/physicians/${physicianId}/schedule`);
  return { ok: true };
}
