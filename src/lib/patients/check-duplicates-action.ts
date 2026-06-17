"use server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { findCandidatesForInput, type ScoredCandidate } from "./find-duplicates";

export interface DupCheckInput {
  first_name: string;
  last_name: string;
  birthdate: string | null;
  email: string | null;
  phone: string | null; // raw phone; normalized here
  excludeId?: string;
}

export type DupCheckResult =
  | { ok: true; candidates: PublicCandidate[] }
  | { ok: false; error: string };

// Staff-only payload — staff are authorized to see identifying details.
export interface PublicCandidate {
  id: string;
  drm_id: string;
  first_name: string;
  last_name: string;
  birthdate: string | null;
  email: string | null;
  phone: string | null;
  tier: ScoredCandidate["score"]["tier"];
  signals: ScoredCandidate["score"]["signals"];
}

function normPhone(raw: string | null): string | null {
  if (!raw) return null;
  const d = raw.replace(/\D/g, "").slice(-10);
  return d.length === 10 ? d : null;
}

export async function checkPatientDuplicatesAction(input: DupCheckInput): Promise<DupCheckResult> {
  await requireActiveStaff();
  if (!input.last_name?.trim() || (!input.email && !input.phone && !input.birthdate)) {
    return { ok: true, candidates: [] };
  }
  const admin = createAdminClient();
  const found = await findCandidatesForInput(
    admin,
    {
      first_name: input.first_name ?? "",
      last_name: input.last_name,
      birthdate: input.birthdate,
      email: input.email,
      phone_normalized: normPhone(input.phone),
      address: null,
      sex: null,
      excludeId: input.excludeId,
    },
    { minTier: "probable" },
  );
  return {
    ok: true,
    candidates: found.map((c) => ({
      id: c.patient.id,
      drm_id: c.patient.drm_id,
      first_name: c.patient.first_name,
      last_name: c.patient.last_name,
      birthdate: c.patient.birthdate,
      email: c.patient.email,
      phone: c.patient.phone_normalized,
      tier: c.score.tier,
      signals: c.score.signals,
    })),
  };
}
