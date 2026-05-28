/**
 * Seeds sample visits + test_requests across all statuses for UI testing
 * of /staff/results. Idempotent: re-running tops up to the target counts.
 *
 *   npx tsx scripts/seed-sample-results.ts   # uses NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from env
 *
 * Run against LOCAL only — refuses prod via the env-guard.
 */
import { createClient } from "@supabase/supabase-js";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
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

async function generatePlaceholderPdf(opts: {
  patientName: string;
  drmId: string;
  serviceCode: string;
  serviceName: string;
  releasedAt: string;
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]); // US Letter
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let y = 740;
  const draw = (text: string, size = 11, f = font, color = rgb(0.13, 0.18, 0.32)) => {
    page.drawText(text, { x: 50, y, size, font: f, color });
    y -= size + 6;
  };
  draw("DR MED CLINIC — Laboratory Result (SAMPLE)", 16, bold);
  y -= 6;
  draw(`Patient: ${opts.patientName}`);
  draw(`DRM-ID:  ${opts.drmId}`);
  draw(`Test:    ${opts.serviceCode} — ${opts.serviceName}`);
  draw(`Released: ${new Date(opts.releasedAt).toLocaleString("en-PH", { timeZone: "Asia/Manila" })}`);
  y -= 12;
  draw("RESULT", 13, bold);
  draw("This is a placeholder PDF generated by the sample-results seed.", 10);
  draw("Real result entry happens through /staff/queue/[id] — medtech", 10);
  draw("upload (image-based) or structured form (chemistry/hematology/etc).", 10);
  y -= 18;
  draw("— Seed file, no clinical content —", 10, font, rgb(0.5, 0.5, 0.5));
  return await doc.save();
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

  // Patient name for placeholder PDFs.
  const { data: pat } = await admin
    .from("patients")
    .select("first_name, last_name, drm_id")
    .eq("id", patientId)
    .maybeSingle();
  const patName = pat ? `${pat.first_name} ${pat.last_name}` : "Sample Patient";
  const patDrm = pat?.drm_id ?? "DRM-?";

  for (const t of visitSpec.tests) {
    const svc = serviceIds.get(t.code);
    if (!svc) throw new Error(`service code ${t.code} not found`);
    const svcMeta = SERVICES.find((s) => s.code === t.code);
    if (!svcMeta) throw new Error(`service meta ${t.code} not found`);
    const requested_at = daysAgoTs(visitSpec.daysAgo);
    const completed_at = ["result_uploaded", "ready_for_release", "released"].includes(t.status)
      ? daysAgoTs(Math.max(0, visitSpec.daysAgo - 0.5))
      : null;
    const released_at = t.status === "released"
      ? daysAgoTs(Math.max(0, visitSpec.daysAgo - 1))
      : null;
    const { data: trRow, error: trErr } = await admin
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
      } as never)
      .select("id")
      .single();
    if (trErr || !trRow) throw new Error(`test_request (${seedMarker} ${t.code}): ${trErr?.message}`);

    // For released tests, upload a placeholder PDF + create results +
    // result_test_requests junction so the PDF column on /staff/results
    // becomes clickable end-to-end.
    if (t.status === "released" && released_at) {
      const trId = (trRow as { id: string }).id;
      const pdfBytes = await generatePlaceholderPdf({
        patientName: patName,
        drmId: patDrm,
        serviceCode: t.code,
        serviceName: svcMeta.name,
        releasedAt: released_at,
      });
      const storagePath = `seed/${trId}.pdf`;
      const { error: upErr } = await admin.storage
        .from("results")
        .upload(storagePath, pdfBytes, { contentType: "application/pdf", upsert: true });
      if (upErr) throw new Error(`storage upload (${t.code}): ${upErr.message}`);

      const { data: resultRow, error: rErr } = await admin
        .from("results")
        .insert({
          generation_kind: "uploaded",
          storage_path: storagePath,
          file_size_bytes: pdfBytes.byteLength,
          uploaded_by: adminId,
          uploaded_at: released_at,
          finalised_at: released_at,
          finalised_by_staff_id: adminId,
          notes: `Seed placeholder PDF for ${t.code}.`,
        } as never)
        .select("id")
        .single();
      if (rErr || !resultRow) throw new Error(`results insert (${t.code}): ${rErr?.message}`);

      const { error: linkErr } = await admin
        .from("result_test_requests")
        .insert({
          result_id: (resultRow as { id: string }).id,
          test_request_id: trId,
        } as never);
      if (linkErr) throw new Error(`junction (${t.code}): ${linkErr.message}`);
    }
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
