import "server-only";
import { SignJWT } from "jose";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

// Patient-scoped Supabase client (PR 9 / H2).
//
// Patients are not Supabase-authenticated (they sign in with DRM-ID + PIN), so
// there is no Postgres role for them. This client mints a short-lived anon-role
// JWT carrying a `patient_id` claim, signed with the project's legacy symmetric
// JWT secret (HS256), and hands it to a normal anon-key client. PostgREST then
// exposes that claim as request.jwt.claims, current_patient_id() reads it, and
// the patient RLS policies evaluate on every query — real row-level enforcement
// rather than the app-level .eq("patient_id", …) filters alone.
//
// Use this for every patient-facing READ. The service-role admin client stays
// only where RLS cannot help: Storage signed-URL minting / downloads (buckets
// have no patient policy), audit_log writes/reads, pre-auth login, and the
// appointment_attachments DELETE (no anon write policy). Keep the existing
// .eq("patient_id", …) filters in place as defense-in-depth.
//
// Signed with `jose` (HS256) to match src/lib/auth/patient-session.ts. Requires
// SUPABASE_JWT_SECRET (the project's legacy JWT secret) — see .env.example.
export async function createPatientClient(patientId: string) {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) throw new Error("SUPABASE_JWT_SECRET is not configured");

  const token = await new SignJWT({ role: "anon", patient_id: patientId })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(secret));

  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
}
