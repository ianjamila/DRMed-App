"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import {
  InquiryCreateSchema,
  InquiryUpdateSchema,
} from "@/lib/validations/inquiry";

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
