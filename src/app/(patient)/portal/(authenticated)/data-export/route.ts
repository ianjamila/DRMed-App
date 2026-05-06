import { headers } from "next/headers";
import JSZip from "jszip";
import { requirePatientProfile } from "@/lib/auth/require-patient";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";

// RA 10173 access right: patients can download a copy of their data.
// Bundled as a ZIP with JSON snapshots + every released result PDF the
// patient can already access via the portal. Access events are
// audit-logged.
//
// Cap the total bundle size so a runaway storage account doesn't melt
// the function. Most patients will be far under this; if a real patient
// ever bumps it we can stream chunks instead.
const MAX_BUNDLE_BYTES = 50 * 1024 * 1024; // 50 MB

export async function GET() {
  const patient = await requirePatientProfile();
  const admin = createAdminClient();
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ua = h.get("user-agent");

  // 1. Patient row (full).
  const { data: patientRow } = await admin
    .from("patients")
    .select("*")
    .eq("id", patient.patient_id)
    .single();

  // 2. Visits + test_requests (status timeline) + payments (their own).
  const { data: visits } = await admin
    .from("visits")
    .select(
      "id, visit_number, visit_date, payment_status, total_php, paid_php, notes, created_at",
    )
    .eq("patient_id", patient.patient_id)
    .order("visit_date", { ascending: false });
  const visitIds = (visits ?? []).map((v) => v.id);

  const [
    { data: testRequests },
    { data: payments },
    { data: appointments },
    { data: auditEntries },
    { data: releasedResults },
  ] = await Promise.all([
    visitIds.length > 0
      ? admin
          .from("test_requests")
          .select(
            "id, visit_id, status, requested_at, started_at, completed_at, released_at, services!inner ( code, name )",
          )
          .in("visit_id", visitIds)
      : Promise.resolve({ data: [] }),
    visitIds.length > 0
      ? admin
          .from("payments")
          .select("id, visit_id, amount_php, method, paid_at, reference")
          .in("visit_id", visitIds)
      : Promise.resolve({ data: [] }),
    admin
      .from("appointments")
      .select(
        "id, scheduled_at, status, notes, created_at, services ( code, name )",
      )
      .eq("patient_id", patient.patient_id)
      .order("created_at", { ascending: false }),
    admin
      .from("audit_log")
      .select("id, action, actor_type, created_at, metadata")
      .eq("patient_id", patient.patient_id)
      .order("created_at", { ascending: false })
      .limit(500),
    admin
      .from("test_requests")
      .select(
        "id, services!inner ( code, name ), results!inner ( storage_path )",
      )
      .eq("status", "released")
      .in("visit_id", visitIds.length > 0 ? visitIds : ["00000000-0000-0000-0000-000000000000"]),
  ]);

  const zip = new JSZip();

  zip.file(
    "README.txt",
    [
      "drmed.ph — Personal Data Export",
      "================================",
      "",
      `Generated for: ${patient.first_name} ${patient.last_name} (${patient.drm_id})`,
      `Generated at:  ${new Date().toISOString()}`,
      "",
      "This archive contains a snapshot of the data drmed.ph holds about",
      "you, exported under your right of access (Republic Act 10173 §16).",
      "",
      "Contents:",
      "  patient.json       — your contact info on file",
      "  visits.json        — every visit and its payment status",
      "  test_requests.json — every test ordered, with status timeline",
      "  payments.json      — payments recorded against your visits",
      "  appointments.json  — your booking history",
      "  audit_log.json     — recent access events on your record (last 500)",
      "  results/           — released result PDFs",
      "",
      "If anything looks wrong, contact reception. You can also request",
      "correction or deletion under RA 10173 §16(c).",
      "",
    ].join("\n"),
  );

  zip.file("patient.json", JSON.stringify(patientRow, null, 2));
  zip.file("visits.json", JSON.stringify(visits ?? [], null, 2));
  zip.file(
    "test_requests.json",
    JSON.stringify(testRequests ?? [], null, 2),
  );
  zip.file("payments.json", JSON.stringify(payments ?? [], null, 2));
  zip.file("appointments.json", JSON.stringify(appointments ?? [], null, 2));
  zip.file("audit_log.json", JSON.stringify(auditEntries ?? [], null, 2));

  // PDF results.
  let bundleBytes = 0;
  let truncated = false;
  for (const tr of releasedResults ?? []) {
    const result = Array.isArray(tr.results) ? tr.results[0] : tr.results;
    const svc = Array.isArray(tr.services) ? tr.services[0] : tr.services;
    if (!result?.storage_path || !svc) continue;
    const { data: blob } = await admin.storage
      .from("results")
      .download(result.storage_path);
    if (!blob) continue;
    const ab = await blob.arrayBuffer();
    if (bundleBytes + ab.byteLength > MAX_BUNDLE_BYTES) {
      truncated = true;
      break;
    }
    bundleBytes += ab.byteLength;
    const filename = `${svc.code}-${tr.id.slice(0, 8)}.pdf`;
    zip.file(`results/${filename}`, ab);
  }
  if (truncated) {
    zip.file(
      "results/_TRUNCATED.txt",
      "The result archive exceeded the 50 MB bundle cap. Some PDFs are missing from this export. Contact reception for a full copy on a USB drive.",
    );
  }

  const buffer = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  await audit({
    actor_id: null,
    actor_type: "patient",
    patient_id: patient.patient_id,
    action: "patient.data_exported",
    resource_type: "patient",
    resource_id: patient.patient_id,
    metadata: {
      bundle_bytes: buffer.byteLength,
      truncated,
      visit_count: visits?.length ?? 0,
      test_request_count: testRequests?.length ?? 0,
      released_result_count: (releasedResults ?? []).length,
    },
    ip_address: ip,
    user_agent: ua,
  });

  const filename = `drmed-${patient.drm_id}-export-${todayManila()}.zip`;
  // Wrap the Uint8Array in a Blob — Response's BodyInit isn't typed to
  // accept the raw typed array directly in this TS lib version.
  return new Response(new Blob([new Uint8Array(buffer)]), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

function todayManila(): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
