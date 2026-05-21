"use server";

import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { billAttachmentUploadSchema } from "@/lib/validations/accounting";
import { reportError } from "@/lib/observability/report-error";

type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string; field?: string | null };

function firstFieldFrom(path: ReadonlyArray<PropertyKey>): string | null {
  const p = path[0];
  return typeof p === "string" ? p : null;
}

const BUCKET = "bill-attachments";

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
}

// ---------------------------------------------------------------------------
// upload
// ---------------------------------------------------------------------------

export async function uploadBillAttachmentAction(
  billId: string,
  file: { name: string; mime_type: string; size_bytes: number; bytes: ArrayBuffer | Uint8Array }
): Promise<ActionResult<{ id: string; storage_path: string }>> {
  const profile = await requireAdminStaff();

  const parsed = billAttachmentUploadSchema.safeParse({
    bill_id: billId,
    filename: file.name,
    mime_type: file.mime_type,
    size_bytes: file.size_bytes,
  });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first?.message ?? "Invalid input",
      field: first ? firstFieldFrom(first.path) : null,
    };
  }

  const admin = createAdminClient();
  const path = `bills/${billId}/${crypto.randomUUID()}-${sanitize(file.name)}`;

  const { error: upErr } = await admin.storage
    .from(BUCKET)
    .upload(path, file.bytes, { contentType: file.mime_type, upsert: false });
  if (upErr) {
    return { ok: false, error: `Upload failed: ${upErr.message}` };
  }

  const { data: inserted, error: insErr } = await admin
    .from("bill_attachments")
    .insert({
      bill_id: billId,
      storage_path: path,
      filename: sanitize(file.name),
      mime_type: file.mime_type,
      size_bytes: file.size_bytes,
      uploaded_by: profile.user_id,
    })
    .select("id")
    .single();

  if (insErr || !inserted) {
    // Best-effort cleanup of the uploaded file
    await admin.storage.from(BUCKET).remove([path]);
    await reportError({ scope: "uploadBillAttachmentAction", error: insErr ?? new Error("Insert returned no row") });
    return { ok: false, error: "Failed to save attachment record" };
  }

  await audit({
    actor_id: profile.user_id,
    actor_type: "staff",
    action: "bill_attachment.uploaded",
    resource_type: "bill_attachment",
    resource_id: inserted.id,
    metadata: { bill_id: billId, filename: sanitize(file.name) },
  });

  return { ok: true, data: { id: inserted.id, storage_path: path } };
}

// ---------------------------------------------------------------------------
// download (signed URL)
// ---------------------------------------------------------------------------

export async function getBillAttachmentDownloadUrlAction(
  attachmentId: string
): Promise<ActionResult<{ url: string }>> {
  const profile = await requireAdminStaff();
  const admin = createAdminClient();

  const { data: att } = await admin
    .from("bill_attachments")
    .select("storage_path")
    .eq("id", attachmentId)
    .maybeSingle() as { data: { storage_path: string } | null };

  if (!att) return { ok: false, error: "Attachment not found" };

  const { data, error } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(att.storage_path, 300);

  if (error || !data) {
    return { ok: false, error: "Failed to create signed URL" };
  }

  await audit({
    actor_id: profile.user_id,
    actor_type: "staff",
    action: "bill_attachment.downloaded",
    resource_type: "bill_attachment",
    resource_id: attachmentId,
    metadata: { storage_path: att.storage_path },
  });

  return { ok: true, data: { url: data.signedUrl } };
}

// ---------------------------------------------------------------------------
// delete (draft bills only)
// ---------------------------------------------------------------------------

type AttachmentRow = {
  storage_path: string;
  bills: { status: string } | { status: string }[] | null;
};

export async function deleteBillAttachmentAction(
  attachmentId: string
): Promise<ActionResult<null>> {
  const profile = await requireAdminStaff();
  const admin = createAdminClient();

  const { data: att } = await admin
    .from("bill_attachments")
    .select("storage_path, bills!bill_id (status)")
    .eq("id", attachmentId)
    .maybeSingle() as { data: AttachmentRow | null };

  if (!att) return { ok: false, error: "Attachment not found" };

  const bill = Array.isArray(att.bills) ? att.bills[0] : att.bills;
  const billStatus = bill?.status;

  if (billStatus !== "draft") {
    return {
      ok: false,
      error: "Cannot delete attachments from a posted bill — BIR record retention applies.",
    };
  }

  await admin.storage.from(BUCKET).remove([att.storage_path]);

  const { error: delErr } = await admin
    .from("bill_attachments")
    .delete()
    .eq("id", attachmentId);

  if (delErr) {
    await reportError({ scope: "deleteBillAttachmentAction", error: delErr });
    return { ok: false, error: "Failed to delete attachment record" };
  }

  await audit({
    actor_id: profile.user_id,
    actor_type: "staff",
    action: "bill_attachment.deleted",
    resource_type: "bill_attachment",
    resource_id: attachmentId,
    metadata: { storage_path: att.storage_path },
  });

  return { ok: true, data: null };
}
