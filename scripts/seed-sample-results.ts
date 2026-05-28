/**
 * Seeds sample visits + test_requests across all statuses for UI testing
 * of /staff/results. Idempotent: re-running tops up to the target counts.
 *
 *   npx tsx scripts/seed-sample-results.ts   # uses NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from env
 *
 * Run against LOCAL only — refuses prod via the env-guard.
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/types/database";
import { requireLocalOrExplicitProd } from "./lib/env-guard";

requireLocalOrExplicitProd("seed-sample-results");

const admin = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const SERVICES: { code: string; name: string; price: number; kind: "lab_test" | "doctor_consultation" }[] = [
  { code: "CBC", name: "Complete Blood Count", price: 250, kind: "lab_test" },
  { code: "URI", name: "Urinalysis", price: 150, kind: "lab_test" },
  { code: "FBS", name: "Fasting Blood Sugar", price: 180, kind: "lab_test" },
  { code: "LIPID", name: "Lipid Profile", price: 850, kind: "lab_test" },
  { code: "CONSULT", name: "Doctor Consultation", price: 500, kind: "doctor_consultation" },
];

const PATIENTS: { drm_id: string; first: string; last: string; bd: string; sex: "male" | "female"; phone: string }[] = [
  { drm_id: "DRM-S-0001", first: "Maria", last: "Santos", bd: "1983-08-14", sex: "female", phone: "+639170000001" },
  { drm_id: "DRM-S-0002", first: "Juan", last: "Dela Cruz", bd: "1975-02-22", sex: "male", phone: "+639170000002" },
  { drm_id: "DRM-S-0003", first: "Ana", last: "Reyes", bd: "1990-11-03", sex: "female", phone: "+639170000003" },
  { drm_id: "DRM-S-0004", first: "Pedro", last: "Garcia", bd: "1962-05-17", sex: "male", phone: "+639170000004" },
];

// One visit per row → list of (service_code, target_status) tuples.
// Spreads coverage across every status pill in the All Results page.
type TestStatus = "requested" | "in_progress" | "result_uploaded" | "ready_for_release" | "released" | "cancelled";

const VISITS: { patient_drm: string; daysAgo: number; tests: { code: string; status: TestStatus }[] }[] = [
  { patient_drm: "DRM-S-0001", daysAgo: 0, tests: [
    { code: "CBC", status: "requested" },
    { code: "URI", status: "in_progress" },
  ]},
  { patient_drm: "DRM-S-0002", daysAgo: 1, tests: [
    { code: "FBS", status: "result_uploaded" },
    { code: "LIPID", status: "ready_for_release" },
  ]},
  { patient_drm: "DRM-S-0003", daysAgo: 3, tests: [
    { code: "CBC", status: "released" },
    { code: "CONSULT", status: "released" },
  ]},
  { patient_drm: "DRM-S-0004", daysAgo: 7, tests: [
    { code: "URI", status: "released" },
    { code: "FBS", status: "cancelled" },
  ]},
  { patient_drm: "DRM-S-0001", daysAgo: 14, tests: [
    { code: "LIPID", status: "released" },
  ]},
];

async function ensureService(s: typeof SERVICES[number]) {
  const existing = await admin.from("services").select("id").eq("code", s.code).maybeSingle();
  if (existing.data?.id) return existing.data.id as string;
  const { data, error } = await admin
    .from("services")
    .insert({
      code: s.code,
      name: s.name,
      kind: s.kind,
      price_php: s.price,
      is_active: true,
    } as never)
    .select("id")
    .single();
  if (error) throw new Error(`service ${s.code}: ${error.message}`);
  console.log(`  + service ${s.code}`);
  return data!.id as string;
}

async function ensurePatient(p: typeof PATIENTS[number], adminId: string) {
  const existing = await admin.from("patients").select("id").eq("drm_id", p.drm_id).maybeSingle();
  if (existing.data?.id) return existing.data.id as string;
  const { data, error } = await admin
    .from("patients")
    .insert({
      drm_id: p.drm_id,
      first_name: p.first,
      last_name: p.last,
      birthdate: p.bd,
      sex: p.sex,
      phone: p.phone,
      pre_registered: false,
      created_by: adminId,
    } as never)
    .select("id")
    .single();
  if (error) throw new Error(`patient ${p.drm_id}: ${error.message}`);
  console.log(`  + patient ${p.drm_id} ${p.first} ${p.last}`);
  return data!.id as string;
}

async function getAdminUserId(): Promise<string> {
  const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  const admin1 = data.users.find((u) => u.email === "admin@drmed.ph");
  if (admin1) return admin1.id;
  // Create one if missing
  const { data: created, error } = await admin.auth.admin.createUser({
    email: "admin@drmed.ph",
    password: "AdminPass123!",
    email_confirm: true,
  });
  if (error) throw new Error(`creating admin user: ${error.message}`);
  await admin.from("staff_profiles").upsert({
    id: created.user!.id,
    full_name: "Seed Admin",
    role: "admin",
    is_active: true,
  } as never);
  console.log(`  + admin user admin@drmed.ph / AdminPass123!`);
  return created.user!.id;
}

function daysAgoTs(d: number): string {
  return new Date(Date.now() - d * 86400000).toISOString();
}

async function createVisitAndTests(
  patientId: string,
  visitSpec: typeof VISITS[number],
  serviceIds: Map<string, { id: string; price: number }>,
  adminId: string,
) {
  // Skip if a visit with this seed marker already exists (idempotency via marker).
  const seedMarker = `SAMPLE-RESULTS-SEED ${visitSpec.patient_drm} d${visitSpec.daysAgo}`;
  const { data: existing } = await admin
    .from("visits")
    .select("id")
    .eq("notes", seedMarker)
    .maybeSingle();
  if (existing?.id) {
    console.log(`  · visit exists ${seedMarker}`);
    return;
  }

  const total = visitSpec.tests.reduce((s, t) => s + (serviceIds.get(t.code)?.price ?? 0), 0);
  const visitDate = daysAgoTs(visitSpec.daysAgo).slice(0, 10);

  const { data: visit, error: vErr } = await admin
    .from("visits")
    .insert({
      patient_id: patientId,
      visit_date: visitDate,
      total_php: total,
      paid_php: total,
      payment_status: "paid",
      notes: seedMarker,
      created_by: adminId,
    } as never)
    .select("id, visit_number")
    .single();
  if (vErr) throw new Error(`visit (${seedMarker}): ${vErr.message}`);

  for (const t of visitSpec.tests) {
    const svc = serviceIds.get(t.code);
    if (!svc) throw new Error(`service code ${t.code} not found`);
    const requested_at = daysAgoTs(visitSpec.daysAgo);
    const completed_at = ["result_uploaded", "ready_for_release", "released"].includes(t.status)
      ? daysAgoTs(Math.max(0, visitSpec.daysAgo - 0.5))
      : null;
    const released_at = t.status === "released"
      ? daysAgoTs(Math.max(0, visitSpec.daysAgo - 1))
      : null;
    const { error: trErr } = await admin
      .from("test_requests")
      .insert({
        visit_id: (visit as { id: string }).id,
        service_id: svc.id,
        status: t.status,
        base_price_php: svc.price,
        final_price_php: svc.price,
        requested_at,
        completed_at,
        released_at,
        requested_by: adminId,
        released_by: released_at ? adminId : null,
      } as never);
    if (trErr) throw new Error(`test_request (${seedMarker} ${t.code}): ${trErr.message}`);
  }
  console.log(`  + visit ${(visit as { visit_number: string }).visit_number} (${visitSpec.tests.length} tests · ${seedMarker})`);
}

async function main() {
  console.log("Services...");
  const serviceIds = new Map<string, { id: string; price: number }>();
  for (const s of SERVICES) {
    serviceIds.set(s.code, { id: await ensureService(s), price: s.price });
  }

  console.log("\nAdmin user...");
  const adminId = await getAdminUserId();

  console.log("\nPatients...");
  const patientIds = new Map<string, string>();
  for (const p of PATIENTS) {
    patientIds.set(p.drm_id, await ensurePatient(p, adminId));
  }

  console.log("\nVisits + test_requests...");
  for (const v of VISITS) {
    const pid = patientIds.get(v.patient_drm);
    if (!pid) throw new Error(`unknown patient ${v.patient_drm}`);
    await createVisitAndTests(pid, v, serviceIds, adminId);
  }

  console.log("\nDone.");
  const { count } = await admin
    .from("test_requests")
    .select("*", { count: "exact", head: true });
  console.log(`Total test_requests on local: ${count}`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
