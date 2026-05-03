"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";
import { requireAdminStaff } from "@/lib/auth/require-admin";

export type ClosureResult = { ok: true } | { ok: false; error: string };

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
