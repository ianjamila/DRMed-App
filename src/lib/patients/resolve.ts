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

// Real wiring. Trigger trg_patients_normalise_email keeps stored emails
// lowercase so equality lookup hits idx_patients_dedup_lookup directly.
export async function resolvePatient(admin: AdminClient, fields: ResolvePatientFields): Promise<ResolvePatientResult> {
  return resolvePatientCore(
    {
      async findExisting(key) {
        const { data } = await admin
          .from("patients")
          .select("id, drm_id")
          .eq("email", key.email)
          .eq("last_name", key.last_name)
          .eq("birthdate", key.birthdate)
          .limit(1)
          .maybeSingle();
        return data ?? null;
      },
      async insertPatient(f) {
        const { data, error } = await admin
          .from("patients")
          .insert({ ...f, pre_registered: true })
          .select("id, drm_id")
          .single();
        if (error || !data) {
          return { ok: false, error: error?.message ?? "Could not save patient details." };
        }
        return { ok: true, id: data.id, drm_id: data.drm_id };
      },
    },
    fields,
  );
}
