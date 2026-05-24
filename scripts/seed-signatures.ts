// scripts/seed-signatures.ts
//
// One-time seed: uploads 6 staff signature PNGs from scripts/seed/signatures/
// to the private `signatures` Supabase Storage bucket and writes the bucket
// path onto each matching staff_profiles row. Creates missing staff_profiles
// (and matching auth.users entries) for consultants who don't log in.
//
// Run with:
//   npm run seed:signatures
//
// Idempotent: a content-hash check skips re-upload when the file is unchanged.

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/types/database";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY. " +
      "Source .env.local first:\n  set -a; . .env.local; set +a",
  );
  process.exit(1);
}

const admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const SIG_DIR = join(process.cwd(), "scripts", "seed", "signatures");

interface ManifestEntry {
  filename: string; // PNG basename in SIG_DIR
  full_name: string; // staff_profiles.full_name (uppercase per existing convention)
  prc_license_no: string;
  prc_license_kind: "RMT" | "MD";
  role: "medtech" | "pathologist" | "admin" | "reception"; // staff_profiles role check
  // Identifying PRC determines the row to update or create — full_name may vary.
}

const MANIFEST: ManifestEntry[] = [
  {
    filename: "rillo.png",
    full_name: "JELOME SUZETTE RILLO",
    prc_license_no: "0063443",
    prc_license_kind: "RMT",
    role: "medtech",
  },
  {
    filename: "romeral.png",
    full_name: "PRINCESS MARA ROMERAL",
    prc_license_no: "0139409",
    prc_license_kind: "RMT",
    role: "medtech",
  },
  {
    filename: "dylim.png",
    full_name: "FREYA MARY JILLIANNE DYLIM",
    prc_license_no: "0069135",
    prc_license_kind: "RMT",
    role: "medtech",
  },
  {
    filename: "tagayuna.png",
    full_name: "PEDRITO Y. TAGAYUNA, MD, FPSP",
    prc_license_no: "0089935",
    prc_license_kind: "MD",
    role: "pathologist",
  },
  {
    filename: "mariano.png",
    full_name: "DANIEL JOHN F. MARIANO, MD, FPCR, FUSP, FCTMRISP, FDBISP",
    prc_license_no: "0098739",
    prc_license_kind: "MD",
    // No 'radiologist' role in the check constraint; closest fit.
    // Renderer keys off prc_license_kind ('MD'), not role, for the printed label.
    role: "pathologist",
  },
  {
    filename: "vicencio.png",
    full_name: "ROBERT ALAIN VICENCIO, MD",
    prc_license_no: "0087903",
    prc_license_kind: "MD",
    // No 'cardiologist' role in the check constraint; closest fit.
    role: "pathologist",
  },
];

async function ensureStaffProfile(entry: ManifestEntry): Promise<string> {
  // Look up by PRC first (most stable identifier).
  const { data: byPrc } = await admin
    .from("staff_profiles")
    .select("id, full_name")
    .eq("prc_license_no", entry.prc_license_no)
    .maybeSingle();

  if (byPrc) {
    // Patch the row's full_name + role + kind in case it's a placeholder.
    if (byPrc.full_name !== entry.full_name) {
      console.log(`  renaming '${byPrc.full_name}' → '${entry.full_name}'`);
    }
    const { error: upErr } = await admin
      .from("staff_profiles")
      .update({
        full_name: entry.full_name,
        prc_license_kind: entry.prc_license_kind,
        role: entry.role,
      })
      .eq("id", byPrc.id);
    if (upErr) throw new Error(`Update staff_profile failed: ${upErr.message}`);
    return byPrc.id;
  }

  // Create a new non-login auth.users + staff_profiles pair.
  const email = `signatory-${entry.prc_license_no}@drmed.internal`;

  const { data: authData, error: authErr } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { signatory_only: true, prc_license_no: entry.prc_license_no },
    // No password → cannot log in via password flow.
  });
  if (authErr) throw new Error(`Create auth.user failed: ${authErr.message}`);
  if (!authData?.user) throw new Error(`No user returned for ${email}`);

  const { error: spErr } = await admin.from("staff_profiles").insert({
    id: authData.user.id,
    full_name: entry.full_name,
    prc_license_no: entry.prc_license_no,
    prc_license_kind: entry.prc_license_kind,
    role: entry.role,
    is_active: true,
  });
  if (spErr) throw new Error(`Insert staff_profile failed: ${spErr.message}`);

  console.log(`  created new staff_profile + auth.user (${entry.full_name})`);
  return authData.user.id;
}

async function uploadIfChanged(staffId: string, bytes: Buffer): Promise<string> {
  const sha = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const path = `${staffId}/${sha}.png`;

  // Check whether the path already has these exact bytes by trying to download.
  const { data: existing } = await admin.storage.from("signatures").download(path);
  if (existing) {
    return path; // identical content already there
  }

  const { error: upErr } = await admin.storage.from("signatures").upload(path, bytes, {
    contentType: "image/png",
    upsert: true,
  });
  if (upErr) throw new Error(`Upload to signatures bucket failed: ${upErr.message}`);
  return path;
}

async function main() {
  for (const entry of MANIFEST) {
    const localPath = join(SIG_DIR, entry.filename);
    if (!existsSync(localPath)) {
      console.error(`Missing PNG: ${localPath}`);
      process.exit(1);
    }
    const bytes = readFileSync(localPath);

    const staffId = await ensureStaffProfile(entry);
    const bucketPath = await uploadIfChanged(staffId, bytes);

    const { error: updErr } = await admin
      .from("staff_profiles")
      .update({
        signature_path: bucketPath,
        signature_uploaded_at: new Date().toISOString(),
      })
      .eq("id", staffId);
    if (updErr) throw new Error(`Update signature_path failed: ${updErr.message}`);

    console.log(`✓ ${entry.full_name} → ${bucketPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
