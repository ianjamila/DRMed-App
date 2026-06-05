// scripts/patient-dedup/lib/types.ts
export interface PatientRow {
  id: string;
  drm_id: string;
  first_name: string | null;
  last_name: string | null;
  middle_name: string | null;
  sex: string | null;
  phone: string | null;
  email: string | null;
  birthdate: string | null;   // ISO date (YYYY-MM-DD) or null
  address: string | null;
  created_at: string;          // ISO timestamp
  visit_count: number;
}

export type Tier = "name+dob" | "name+phone" | "name+email";
export type ReviewReason = "name-only" | "dob-conflict" | "sex-conflict";

export interface ClusterPlan {
  canonical: PatientRow;
  auto: Array<{ row: PatientRow; tier: Tier }>;
  review: Array<{ row: PatientRow; reason: ReviewReason }>;
}
