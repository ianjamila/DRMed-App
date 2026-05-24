// Server-only signature image loader for result PDF rendering.
//
// Resolves the consultant staff IDs from env vars, fetches each
// staff_profiles row, downloads the PNG bytes from the private
// 'signatures' Supabase Storage bucket via the admin client, and returns
// a typed payload for embedding into the PDF. Throws on any
// misconfiguration (missing env var, missing staff_profile, missing
// signature_path) so render must fail-fast rather than ship a PDF with
// a missing signature.

import { createAdminClient } from "@/lib/supabase/admin";

export interface SignatureBlockData {
  full_name: string;
  prc_license_no: string | null;
  prc_license_kind: string | null;
  png_bytes: Buffer | null;
}

type ConsultantEnvKey =
  | "CONSULTANT_PATHOLOGIST_STAFF_ID"
  | "CONSULTANT_RADIOLOGIST_STAFF_ID"
  | "CONSULTANT_CARDIOLOGIST_STAFF_ID";

function requireEnv(key: ConsultantEnvKey): string {
  const v = process.env[key];
  if (!v || v.length === 0) {
    throw new Error(
      `${key} env var is required for result PDF rendering — see .env.example.`,
    );
  }
  return v;
}

export async function loadConsultantSignatures(): Promise<{
  pathologist: SignatureBlockData;
  radiologist: SignatureBlockData;
  cardiologist: SignatureBlockData;
}> {
  const ids = {
    pathologist: requireEnv("CONSULTANT_PATHOLOGIST_STAFF_ID"),
    radiologist: requireEnv("CONSULTANT_RADIOLOGIST_STAFF_ID"),
    cardiologist: requireEnv("CONSULTANT_CARDIOLOGIST_STAFF_ID"),
  };
  return {
    pathologist: await loadSignatureForStaff(ids.pathologist),
    radiologist: await loadSignatureForStaff(ids.radiologist),
    cardiologist: await loadSignatureForStaff(ids.cardiologist),
  };
}

export async function loadSignatureForStaff(
  staffId: string,
): Promise<SignatureBlockData> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("staff_profiles")
    .select("full_name, prc_license_no, prc_license_kind, signature_path")
    .eq("id", staffId)
    .single();
  if (error || !data) {
    throw new Error(
      `Failed to load staff_profile ${staffId} for signature: ${error?.message ?? "row not found"}`,
    );
  }

  let png_bytes: Buffer | null = null;
  if (data.signature_path) {
    const { data: file, error: dlErr } = await admin.storage
      .from("signatures")
      .download(data.signature_path);
    if (dlErr || !file) {
      throw new Error(
        `Failed to download signature ${data.signature_path}: ${dlErr?.message ?? "no file"}`,
      );
    }
    png_bytes = Buffer.from(await file.arrayBuffer());
  }

  return {
    full_name: data.full_name,
    prc_license_no: data.prc_license_no,
    prc_license_kind: data.prc_license_kind,
    png_bytes,
  };
}

type ServiceShape = { code: string; kind: string | null };

/**
 * Resolves the "performer" signature column. For imaging (X-ray, ultrasound)
 * the consultant radiologist signs; for ECG the consultant cardiologist;
 * otherwise the staff member identified by finalisedByStaffId (typically
 * the medtech who finalised). Returns null if there's no finaliser yet.
 */
export async function resolvePerformer(args: {
  service: ServiceShape | null;
  finalisedByStaffId: string | null;
}): Promise<SignatureBlockData | null> {
  const code = args.service?.code ?? "";
  const kind = args.service?.kind ?? "";
  const consultants = await loadConsultantSignatures();

  if (/^XRAY|^US|^ULTRASOUND/i.test(code) || kind === "imaging") {
    return consultants.radiologist;
  }
  if (/^ECG/i.test(code)) {
    return consultants.cardiologist;
  }
  if (args.finalisedByStaffId) {
    return await loadSignatureForStaff(args.finalisedByStaffId);
  }
  return null;
}
