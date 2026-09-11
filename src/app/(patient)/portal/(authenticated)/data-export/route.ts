import { headers } from "next/headers";
import JSZip from "jszip";
import { requirePatientProfile } from "@/lib/auth/require-patient";
import { createPatientClient } from "@/lib/supabase/patient";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { chunk, fetchAllRows, IN_CHUNK, REPORT_EXPORT_MAX_ROWS } from "@/lib/reports/paging";

// RA 10173 access right: patients can download a copy of their data.
// Bundled as a ZIP with JSON snapshots + every released result PDF the
// patient can already access via the portal. Access events are
// audit-logged.
//
// Cap the total bundle size so a runaway storage account doesn't melt
// the function. Most patients will be far under this; if a real patient
// ever bumps it we can stream chunks instead.
const MAX_BUNDLE_BYTES = 50 * 1024 * 1024; // 50 MB

// N10: `maxDuration` matches the other paged exports — walking a patient's
// full history in REPORT_EXPORT_MAX_ROWS-capped, IN_CHUNK-batched pages is
// still bounded work, but a patient with an unusually long history (or a
// slow storage download loop below) needs more than the 10s default.
export const maxDuration = 60;

interface VisitRow {
  id: string;
  visit_number: string;
  visit_date: string;
  payment_status: string;
  total_php: number;
  paid_php: number;
  notes: string | null;
  created_at: string;
}

interface TestRequestRow {
  id: string;
  visit_id: string;
  status: string;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  released_at: string | null;
  services: { code: string; name: string } | { code: string; name: string }[] | null;
}

interface PaymentRow {
  id: string;
  visit_id: string;
  amount_php: number;
  method: string | null;
  received_at: string;
  reference_number: string | null;
}

interface AppointmentRow {
  id: string;
  scheduled_at: string;
  status: string;
  notes: string | null;
  created_at: string;
  services: { code: string; name: string } | { code: string; name: string }[] | null;
}

type JRow = {
  test_request_id: string;
  results: { storage_path: string | null } | { storage_path: string | null }[] | null;
  test_requests:
    | {
        id: string;
        services: { code: string; name: string } | { code: string; name: string }[] | null;
      }
    | {
        id: string;
        services: { code: string; name: string } | { code: string; name: string }[] | null;
      }[]
    | null;
};

export async function GET() {
  const patient = await requirePatientProfile();
  // Patient-scoped client for every data read (RLS-enforced ownership). The
  // service-role client stays only for what RLS can't serve: the audit_log read
  // (compliance ledger, deliberately not patient-RLS-readable) and the Storage
  // .download() of result PDFs (buckets have no patient policy). All the
  // existing .eq("patient_id"/"visit_id", …) filters stay as defense-in-depth.
  const db = await createPatientClient(patient.patient_id);
  const admin = createAdminClient();
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ua = h.get("user-agent");

  // 1. Patient row (full).
  const { data: patientRow } = await db
    .from("patients")
    .select("*")
    .eq("id", patient.patient_id)
    .single();

  // 2. Visits — every matching row (not just the first page), and never a
  // soft-deleted one (0125: "every read surface" includes the portal).
  // `visits: patient self select` RLS scopes by patient_id only, NOT
  // deleted_at, so this app-level filter is the only thing hiding a deleted
  // visit from a patient's own export.
  const { rows: visits, truncated: visitsTruncated } = await fetchAllRows<VisitRow>(
    (from, to) =>
      db
        .from("visits")
        .select(
          "id, visit_number, visit_date, payment_status, total_php, paid_php, notes, created_at",
        )
        .eq("patient_id", patient.patient_id)
        .is("deleted_at", null)
        .order("visit_date", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to)
        .returns<VisitRow[]>(),
    REPORT_EXPORT_MAX_ROWS,
  );
  const visitIds = visits.map((v) => v.id);

  // 3. Everything keyed off those visits — chunked past PostgREST's `.in()`
  // practical limits AND its 1000-row response cap, mirroring the pattern
  // `patients-without-consent.ts` uses for the same "N ids → M rows" shape.
  async function fetchByVisitIds<T>(
    buildPage: (ids: string[], from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  ): Promise<{ rows: T[]; truncated: boolean }> {
    const rows: T[] = [];
    let truncated = false;
    for (const ids of chunk(visitIds, IN_CHUNK)) {
      const chunkResult = await fetchAllRows<T>(
        (from, to) => buildPage(ids, from, to),
        REPORT_EXPORT_MAX_ROWS,
      );
      rows.push(...chunkResult.rows);
      truncated ||= chunkResult.truncated;
    }
    return { rows, truncated };
  }

  const [testRequestsResult, paymentsResult, appointmentsResult, auditResult, releasedResultsResult] =
    await Promise.all([
      // 0125: filter deleted_at is null — a soft-deleted test line isn't
      // owed, and isn't something the patient needs echoed back either.
      fetchByVisitIds<TestRequestRow>((ids, from, to) =>
        db
          .from("test_requests")
          .select(
            "id, visit_id, status, requested_at, started_at, completed_at, released_at, services!inner ( code, name )",
          )
          .in("visit_id", ids)
          .is("deleted_at", null)
          .order("id", { ascending: true })
          .range(from, to)
          .returns<TestRequestRow[]>(),
      ),
      fetchByVisitIds<PaymentRow>((ids, from, to) =>
        db
          .from("payments")
          // N10: the real column names are `received_at` / `reference_number`
          // — the old `paid_at, reference` select matched no column, so
          // PostgREST silently returned an empty projection and
          // payments.json was ALWAYS `[]`. Confirmed against
          // src/types/database.ts, not guessed.
          .select("id, visit_id, amount_php, method, received_at, reference_number")
          .in("visit_id", ids)
          .order("id", { ascending: true })
          .range(from, to)
          .returns<PaymentRow[]>(),
      ),
      fetchAllRows<AppointmentRow>(
        (from, to) =>
          db
            .from("appointments")
            .select("id, scheduled_at, status, notes, created_at, services ( code, name )")
            .eq("patient_id", patient.patient_id)
            .order("created_at", { ascending: false })
            .order("id", { ascending: true })
            .range(from, to)
            .returns<AppointmentRow[]>(),
        REPORT_EXPORT_MAX_ROWS,
      ),
      // audit_log stays on the service-role client: the compliance ledger is
      // deliberately not patient-RLS-readable. Deliberately still capped at
      // the last 500 (documented in the README below) — an access-events
      // ledger, not the primary record, so a rolling window is the honest
      // scope rather than every row this account has ever produced.
      admin
        .from("audit_log")
        .select("id, action, actor_type, created_at, metadata")
        .eq("patient_id", patient.patient_id)
        .order("created_at", { ascending: false })
        .limit(500),
      fetchByVisitIds<JRow>((ids, from, to) =>
        db
          .from("result_test_requests")
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .select("test_request_id, results!inner(storage_path), test_requests!inner(id, visit_id, status, deleted_at, services!inner(code, name))" as any)
          .eq("test_requests.status", "released")
          .is("test_requests.deleted_at", null)
          .in("test_requests.visit_id", ids)
          .order("test_request_id", { ascending: true })
          .range(from, to)
          .returns<JRow[]>(),
      ),
    ]);

  const testRequests = testRequestsResult.rows;
  const payments = paymentsResult.rows;
  const appointments = appointmentsResult.rows;
  const auditEntries = auditResult.data ?? [];
  const releasedResults = releasedResultsResult.rows;
  const truncated =
    visitsTruncated ||
    testRequestsResult.truncated ||
    paymentsResult.truncated ||
    appointmentsResult.truncated ||
    releasedResultsResult.truncated;

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
      ...(truncated
        ? [
            "NOTE: one or more sections exceeded this export's row ceiling and",
            "were cut off. Contact reception for a complete copy.",
            "",
          ]
        : []),
    ].join("\n"),
  );

  zip.file("patient.json", JSON.stringify(patientRow, null, 2));
  zip.file("visits.json", JSON.stringify(visits, null, 2));
  zip.file("test_requests.json", JSON.stringify(testRequests, null, 2));
  zip.file("payments.json", JSON.stringify(payments, null, 2));
  zip.file("appointments.json", JSON.stringify(appointments, null, 2));
  zip.file("audit_log.json", JSON.stringify(auditEntries, null, 2));

  // PDF results — deduplicated by storage_path so consolidated reports
  // (multiple test_requests pointing to one result) are only bundled once.
  let bundleBytes = 0;
  let bundleTruncated = false;
  const seenPaths = new Set<string>();
  for (const jRow of releasedResults) {
    const result = Array.isArray(jRow.results) ? jRow.results[0] : jRow.results;
    const tr = Array.isArray(jRow.test_requests) ? jRow.test_requests[0] : jRow.test_requests;
    const svc = tr
      ? (Array.isArray(tr.services) ? tr.services[0] : tr.services)
      : null;
    if (!result?.storage_path || !svc) continue;
    if (seenPaths.has(result.storage_path)) continue;
    seenPaths.add(result.storage_path);
    const { data: blob } = await admin.storage
      .from("results")
      .download(result.storage_path);
    if (!blob) continue;
    const ab = await blob.arrayBuffer();
    if (bundleBytes + ab.byteLength > MAX_BUNDLE_BYTES) {
      bundleTruncated = true;
      break;
    }
    bundleBytes += ab.byteLength;
    const trId = tr?.id ?? jRow.test_request_id;
    const filename = `${svc.code}-${trId.slice(0, 8)}.pdf`;
    zip.file(`results/${filename}`, ab);
  }
  if (bundleTruncated) {
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
      truncated: bundleTruncated || truncated,
      visit_count: visits.length,
      test_request_count: testRequests.length,
      released_result_count: releasedResults.length,
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
