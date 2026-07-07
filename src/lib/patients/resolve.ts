import type { createAdminClient } from "@/lib/supabase/admin";

// NOTE: no `import "server-only"` — the DB wrapper receives the admin client as
// a param (never imports the service-role key), so this module stays unit-testable.
// resolvePatient must only ever be called from server code (it is handed an admin client).

export interface ResolvePatientFields {
  first_name: string;
  last_name: string;
  middle_name: string | null;
  birthdate: string;
  sex: "male" | "female" | null;
  phone: string | null;
  email: string; // dedup key — required
  address: string | null;
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
// (resolve_patient_guarded, migration 0112): an advisory xact-lock on the
// dedup triple makes concurrent resolves of the same identity yield one row.
// Same contract as resolvePatientCore — reuse on (lower(email), last_name,
// birthdate), else insert with pre_registered = true, never overwrite an
// existing row's contact fields.
export async function resolvePatient(admin: AdminClient, fields: ResolvePatientFields): Promise<ResolvePatientResult> {
  const email = fields.email.trim().toLowerCase();
  const { data, error } = await admin.rpc("resolve_patient_guarded", {
    p_email: email,
    p_last_name: fields.last_name,
    p_birthdate: fields.birthdate,
    p_fields: { ...fields, email },
  });
  const row = data?.[0];
  if (error || !row) return { ok: false, error: error?.message ?? "Could not save patient details." };
  return { ok: true, id: row.id, drm_id: row.drm_id, reused: row.reused };
}
