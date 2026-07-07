import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// Mint a short-lived signed URL for a private Storage object. Storage buckets
// have no patient RLS policy (patients never get direct bucket access), so
// signing is unavoidably a service-role operation — this helper is the single
// choke point for it, keeping the service-role client out of the portal pages
// (they read the database through the patient-scoped client instead; see
// src/lib/supabase/patient.ts and src/lib/portal/portal-scoping.test.ts).
//
// This does NOT audit-log: it is used for inline previews (e.g. upload
// thumbnails). Access that must be logged for RA 10173 (result downloads,
// full-size form views) goes through the audited Server Actions in the portal
// actions.ts, not this helper.
export async function createStorageSignedUrl(
  bucket: string,
  path: string,
  expiresInSeconds = 60 * 5,
): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin.storage
    .from(bucket)
    .createSignedUrl(path, expiresInSeconds);
  return data?.signedUrl ?? null;
}
