"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { z } from "zod";
import {
  InquiryCreateSchema,
  InquiryUpdateSchema,
} from "@/lib/validations/inquiry";

const BookFromInquirySchema = z.object({
  scheduled_at: z
    .string()
    .trim()
    .min(1, "Pick a date and time.")
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, "Invalid date/time.")
    .transform((v) => `${v.length === 16 ? `${v}:00` : v}+08:00`),
  service_id: z
    .union([z.string(), z.null(), z.undefined()])
    .transform((v) => {
      const t = (v ?? "").toString().trim();
      return t.length === 0 ? null : t;
    })
    .pipe(z.string().uuid("Invalid service.").nullable()),
  notes: z
    .union([z.string(), z.null(), z.undefined()])
    .transform((v) => {
      const t = (v ?? "").toString().trim();
      return t.length === 0 ? null : t;
    })
    .pipe(z.string().max(2000).nullable()),
});

export type InquiryResult =
  | { ok: true }
  | { ok: false; error: string };

function readForm(formData: FormData) {
  return {
    caller_name: formData.get("caller_name"),
    contact: formData.get("contact"),
    channel: formData.get("channel"),
    service_interest: formData.get("service_interest"),
    called_at: formData.get("called_at"),
    received_by_id: formData.get("received_by_id"),
    status: formData.get("status"),
    drop_reason: formData.get("drop_reason"),
    notes: formData.get("notes"),
  };
}

function requireReception(
  role: "reception" | "medtech" | "pathologist" | "admin",
): boolean {
  return role === "reception" || role === "admin";
}

async function ipAndAgent() {
  const h = await headers();
  return {
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    ua: h.get("user-agent"),
  };
}

export async function createInquiryAction(
  _prev: InquiryResult | null,
  formData: FormData,
): Promise<InquiryResult> {
  const session = await requireActiveStaff();
  if (!requireReception(session.role)) {
    return { ok: false, error: "Reception or admin access required." };
  }

  const parsed = InquiryCreateSchema.safeParse(readForm(formData));
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  const admin = createAdminClient();
  const { data: created, error } = await admin
    .from("inquiries")
    .insert({
      ...parsed.data,
      // Drop reason isn't stored when status is pending — keep the row tidy.
      drop_reason:
        parsed.data.status === "dropped" ? parsed.data.drop_reason : null,
      created_by: session.user_id,
    })
    .select("id, status")
    .single();
  if (error || !created) {
    return { ok: false, error: error?.message ?? "Could not save inquiry." };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "inquiry.created",
    resource_type: "inquiry",
    resource_id: created.id,
    metadata: {
      caller_name: parsed.data.caller_name,
      channel: parsed.data.channel,
      status: created.status,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath("/staff/inquiries");
  redirect("/staff/inquiries");
}

export async function updateInquiryAction(
  inquiryId: string,
  _prev: InquiryResult | null,
  formData: FormData,
): Promise<InquiryResult> {
  const session = await requireActiveStaff();
  if (!requireReception(session.role)) {
    return { ok: false, error: "Reception or admin access required." };
  }

  const parsed = InquiryUpdateSchema.safeParse(readForm(formData));
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  const admin = createAdminClient();

  // The form never lets reception pick "confirmed" directly, but the row
  // may already be confirmed (linked to an appointment/visit via P10.4).
  // In that case, leave status alone — the form value only governs the
  // pending⇄dropped distinction.
  const { data: current } = await admin
    .from("inquiries")
    .select("status, linked_appointment_id, linked_visit_id")
    .eq("id", inquiryId)
    .single();

  const isLocked = current?.status === "confirmed";
  const nextStatus = isLocked ? "confirmed" : parsed.data.status;

  const { error } = await admin
    .from("inquiries")
    .update({
      caller_name: parsed.data.caller_name,
      contact: parsed.data.contact,
      channel: parsed.data.channel,
      service_interest: parsed.data.service_interest,
      called_at: parsed.data.called_at,
      received_by_id: parsed.data.received_by_id,
      notes: parsed.data.notes,
      status: nextStatus,
      drop_reason:
        nextStatus === "dropped" ? parsed.data.drop_reason : null,
    })
    .eq("id", inquiryId);
  if (error) return { ok: false, error: error.message };

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "inquiry.updated",
    resource_type: "inquiry",
    resource_id: inquiryId,
    metadata: {
      status: nextStatus,
      drop_reason_set: nextStatus === "dropped",
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath("/staff/inquiries");
  revalidatePath(`/staff/inquiries/${inquiryId}/edit`);
  redirect("/staff/inquiries");
}

// Promote a pending inquiry to a confirmed booking. Creates a walk-in
// appointment with the caller's name + contact (no patient record yet —
// reception promotes to patient when the lead actually arrives), then
// links the appointment back to the inquiry and flips status to confirmed.
export async function bookFromInquiryAction(
  inquiryId: string,
  _prev: InquiryResult | null,
  formData: FormData,
): Promise<InquiryResult> {
  const session = await requireActiveStaff();
  if (!requireReception(session.role)) {
    return { ok: false, error: "Reception or admin access required." };
  }

  const parsed = BookFromInquirySchema.safeParse({
    scheduled_at: formData.get("scheduled_at"),
    service_id: formData.get("service_id"),
    notes: formData.get("notes"),
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  const admin = createAdminClient();

  const { data: inquiry, error: inquiryErr } = await admin
    .from("inquiries")
    .select("id, caller_name, contact, status")
    .eq("id", inquiryId)
    .maybeSingle();
  if (inquiryErr || !inquiry) {
    return { ok: false, error: "Inquiry not found." };
  }
  if (inquiry.status === "confirmed") {
    return { ok: false, error: "This inquiry is already confirmed." };
  }

  const { data: appointment, error: apptErr } = await admin
    .from("appointments")
    .insert({
      walk_in_name: inquiry.caller_name,
      walk_in_phone: inquiry.contact,
      service_id: parsed.data.service_id,
      scheduled_at: parsed.data.scheduled_at,
      notes: parsed.data.notes,
      status: "confirmed",
      created_by: session.user_id,
    })
    .select("id, scheduled_at")
    .single();
  if (apptErr || !appointment) {
    return {
      ok: false,
      error: apptErr?.message ?? "Could not create the appointment.",
    };
  }

  const { error: updErr } = await admin
    .from("inquiries")
    .update({
      status: "confirmed",
      linked_appointment_id: appointment.id,
      // Clear any prior drop reason in case reception is re-opening a
      // dropped inquiry that came back.
      drop_reason: null,
    })
    .eq("id", inquiryId);
  if (updErr) {
    // Best-effort rollback: delete the orphan appointment so reception
    // doesn't see a phantom booking. RLS allows admin client to delete.
    await admin.from("appointments").delete().eq("id", appointment.id);
    return { ok: false, error: updErr.message };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "inquiry.booked",
    resource_type: "inquiry",
    resource_id: inquiryId,
    metadata: {
      appointment_id: appointment.id,
      scheduled_at: appointment.scheduled_at,
      service_id: parsed.data.service_id,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath("/staff/inquiries");
  revalidatePath(`/staff/inquiries/${inquiryId}/edit`);
  revalidatePath("/staff/appointments");
  redirect("/staff/appointments");
}
