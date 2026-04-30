"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export type UploadResult = { ok: true } | { ok: false; error: string };

export async function uploadResultAction(
  testRequestId: string,
  formData: FormData,
): Promise<UploadResult> {
  const session = await requireActiveStaff();

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Please attach a PDF file." };
  }
  if (file.type !== "application/pdf") {
    return { ok: false, error: "File must be a PDF." };
  }
  if (file.size > MAX_BYTES) {
    return { ok: false, error: "PDF must be 10 MB or less." };
  }

  const notes = (formData.get("notes") ?? "").toString().trim();

  const supabase = await createClient();
  const { data: testRequest } = await supabase
    .from("test_requests")
    .select(
      `
        id, status, visit_id,
        visits!inner ( id, patient_id )
      `,
    )
    .eq("id", testRequestId)
    .maybeSingle();

  if (!testRequest) return { ok: false, error: "Test not found." };
  if (testRequest.status !== "in_progress") {
    return {
      ok: false,
      error: `Test must be in_progress to upload (currently ${testRequest.status}).`,
    };
  }
  const visit = Array.isArray(testRequest.visits)
    ? testRequest.visits[0]
    : testRequest.visits;
  if (!visit) return { ok: false, error: "Visit not found." };

  const path = `${visit.patient_id}/${visit.id}/${testRequest.id}.pdf`;
  const admin = createAdminClient();

  // Upload (overwrite if a previous attempt left a stray file).
  const buffer = Buffer.from(await file.arrayBuffer());
  const { error: uploadErr } = await admin.storage
    .from("results")
    .upload(path, buffer, {
      contentType: "application/pdf",
      upsert: true,
    });
  if (uploadErr) {
    return { ok: false, error: `Upload failed: ${uploadErr.message}` };
  }

  // Insert results row — trigger auto-flips test_requests.status.
  const { data: resultRow, error: insertErr } = await admin
    .from("results")
    .insert({
      test_request_id: testRequest.id,
      storage_path: path,
      file_size_bytes: file.size,
      uploaded_by: session.user_id,
      notes: notes || null,
    })
    .select("id")
    .single();

  if (insertErr || !resultRow) {
    // Best-effort cleanup of the storage object so we don't orphan it.
    await admin.storage.from("results").remove([path]);
    return {
      ok: false,
      error: insertErr?.message ?? "Could not record the result.",
    };
  }

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "result.uploaded",
    resource_type: "result",
    resource_id: resultRow.id,
    metadata: {
      test_request_id: testRequest.id,
      visit_id: visit.id,
      storage_path: path,
      file_size_bytes: file.size,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/queue");
  revalidatePath(`/staff/queue/${testRequest.id}`);
  revalidatePath(`/staff/visits/${visit.id}`);
  return { ok: true };
}

export async function getResultDownloadUrl(
  testRequestId: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const session = await requireActiveStaff();
  const admin = createAdminClient();

  const { data: result } = await admin
    .from("results")
    .select("id, storage_path, test_request_id")
    .eq("test_request_id", testRequestId)
    .maybeSingle();

  if (!result) return { ok: false, error: "No result file." };

  const { data: signed, error } = await admin.storage
    .from("results")
    .createSignedUrl(result.storage_path, 60 * 5); // 5 min

  if (error || !signed?.signedUrl) {
    return { ok: false, error: error?.message ?? "Could not sign URL." };
  }

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "result.viewed",
    resource_type: "result",
    resource_id: result.id,
    metadata: { test_request_id: testRequestId, viewer_role: session.role },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  return { ok: true, url: signed.signedUrl };
}
