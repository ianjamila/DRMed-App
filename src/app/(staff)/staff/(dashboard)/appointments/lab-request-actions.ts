"use server";

import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";

const BUCKET = "lab-request-forms";

type Result = { ok: true; url: string } | { ok: false; error: string };

export async function getLabRequestFormUrlAction(attachmentId: string): Promise<Result> {
  const profile = await requireActiveStaff();
  const admin = createAdminClient();

  const { data: att } = await admin
    .from("appointment_attachments")
    .select("storage_path")
    .eq("id", attachmentId)
    .maybeSingle();

  if (!att) return { ok: false, error: "Attachment not found." };

  const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(att.storage_path, 300);
  if (error || !data) return { ok: false, error: "Could not open the file." };

  await audit({
    actor_id: profile.user_id,
    actor_type: "staff",
    action: "lab_request.viewed",
    resource_type: "appointment_attachment",
    resource_id: attachmentId,
    metadata: { storage_path: att.storage_path },
  });

  return { ok: true, url: data.signedUrl };
}
