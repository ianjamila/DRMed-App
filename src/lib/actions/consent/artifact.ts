"use server";

import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { ipAndAgent, firstIssue } from "@/lib/server/action-helpers";
import { requireActiveStaff } from "@/lib/auth/require-staff";

const UploadSchema = z.object({
  patientId: z.string().uuid(),
  dataUrl: z
    .string()
    .regex(
      /^data:(image\/png|image\/jpeg|application\/pdf);base64,/,
    ),
  ext: z.enum(["png", "jpg", "pdf"]),
});

export type UploadArtifactResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

export async function uploadConsentArtifactAction(
  raw: z.input<typeof UploadSchema>,
): Promise<UploadArtifactResult> {
  await requireActiveStaff();
  const parsed = UploadSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const { patientId, dataUrl, ext } = parsed.data;

  const base64 = dataUrl.split(",")[1] ?? "";
  const bytes = Buffer.from(base64, "base64");
  const contentType =
    ext === "pdf"
      ? "application/pdf"
      : ext === "png"
        ? "image/png"
        : "image/jpeg";
  const path = `${patientId}/${crypto.randomUUID()}.${ext}`;

  const admin = createAdminClient();
  const { error } = await admin.storage
    .from("consent-artifacts")
    .upload(path, bytes, { contentType, upsert: false });
  if (error)
    return {
      ok: false,
      error: "Could not store the signed form. Try again.",
    };

  return { ok: true, path };
}

const ViewSchema = z.object({
  patientId: z.string().uuid(),
  path: z.string().min(1),
});

export type ViewArtifactResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

export async function viewConsentArtifactAction(
  raw: z.input<typeof ViewSchema>,
): Promise<ViewArtifactResult> {
  const session = await requireActiveStaff();
  const parsed = ViewSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const { patientId, path } = parsed.data;

  const admin = createAdminClient();
  const { data, error } = await admin.storage
    .from("consent-artifacts")
    .createSignedUrl(path, 300);
  if (error || !data)
    return { ok: false, error: "Could not open the document." };

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    patient_id: patientId,
    action: "consent.artifact_viewed",
    resource_type: "patient",
    resource_id: patientId,
    metadata: { path },
    ip_address: ip,
    user_agent: ua,
  });

  return { ok: true, url: data.signedUrl };
}
