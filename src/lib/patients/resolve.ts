import type { createAdminClient } from "@/lib/supabase/admin";
import type { ReferralSourceId } from "@/lib/patients/referral-sources";
import { withLifecycleRetry } from "@/lib/patients/lifecycle-retry";
import type { DbErrorTranslator } from "@/lib/patients/public-db-error";

// NOTE: no `import "server-only"` — the DB wrapper receives the admin client as
// a param (never imports the service-role key), so this module stays unit-testable.
// resolvePatient must only ever be called from server code (it is handed an admin client).
// The caller chooses how a database error reads: staff actions pass
// translatePgError, the public /schedule and /register forms pass
// publicDbError — translatePgError passes staff-only messages through, and
// pg-errors-staff-only.test.ts fails if a public page can import it.

export interface ResolvePatientFields {
  first_name: string;
  last_name: string;
  middle_name: string | null;
  birthdate: string;
  sex: "male" | "female" | null;
  phone: string | null;
  email: string; // dedup key — required
  address: string | null;
  // "How did you hear about us?" from the public forms (0158). Written only
  // when this call CREATES the patient; a matched row keeps whatever it had.
  // The staff slide-over does not ask, so it passes nothing (NULL).
  referral_source?: ReferralSourceId | null;
}

export type ResolvePatientResult =
  | { ok: true; id: string; drm_id: string; reused: boolean }
  | { ok: false; error: string };

export interface ResolvePatientDeps {
  findExisting: (key: { email: string; last_name: string; birthdate: string }) => Promise<{ id: string; drm_id: string } | null>;
  insertPatient: (fields: ResolvePatientFields) => Promise<{ ok: true; id: string; drm_id: string } | { ok: false; error: string }>;
}

// Silent dedup: reuse the patient matched by (lower(email), last_name,
// birthdate); otherwise insert. Strict on purpose — these three rarely collide
// for unrelated people, and a family member differs on last_name or birthdate.
// Existing contact fields are NOT overwritten. Pure orchestration over injected
// deps so it's testable without a live DB.
export async function resolvePatientCore(
  deps: ResolvePatientDeps,
  fields: ResolvePatientFields,
): Promise<ResolvePatientResult> {
  const email = fields.email.trim().toLowerCase();
  const existing = await deps.findExisting({ email, last_name: fields.last_name, birthdate: fields.birthdate });
  if (existing) {
    return { ok: true, id: existing.id, drm_id: existing.drm_id, reused: true };
  }
  const inserted = await deps.insertPatient({ ...fields, email });
  if (!inserted.ok) return inserted;
  return { ok: true, id: inserted.id, drm_id: inserted.drm_id, reused: false };
}

type AdminClient = ReturnType<typeof createAdminClient>;

// Real wiring. The dedup check-then-insert now lives in the DB
// (resolve_patient_guarded, migration 0112, hardened by 0184): an advisory
// xact-lock on the dedup triple makes concurrent resolves of the same
// identity yield one row. Reuse is on (lower(email), lower(last_name),
// birthdate) since 0184 (case-insensitive last name), active records only
// (deleted_at is null and merged_into_id is null, 0167), oldest first; else
// insert with pre_registered = true, never overwrite an existing row's
// contact fields (or its referral_source, 0158). 0184 also takes the
// candidate's lifecycle lock and re-reads it before committing, raising
// P0072 if it changed/was deleted/merged mid-flight — withLifecycleRetry
// retries that (and a deadlock/serialization loss) once, in a fresh
// transaction, before giving up.
export async function resolvePatient(
  admin: AdminClient,
  fields: ResolvePatientFields,
  translateError: DbErrorTranslator,
): Promise<ResolvePatientResult> {
  const email = fields.email.trim().toLowerCase();
  const { data, error } = await withLifecycleRetry(() =>
    admin.rpc("resolve_patient_guarded", {
      p_email: email,
      p_last_name: fields.last_name,
      p_birthdate: fields.birthdate,
      p_fields: { ...fields, email },
    }),
  );
  const row = data?.[0];
  if (error || !row) {
    if (!error) return { ok: false, error: "Could not save patient details." };
    return { ok: false, error: translateError(error) };
  }
  return { ok: true, id: row.id, drm_id: row.drm_id, reused: row.reused };
}
