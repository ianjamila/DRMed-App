import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseEmailLogRow } from "./parse-row";
import {
  EMAIL_ACTIONS,
  type EmailAuditRow,
  type EmailLogEntry,
  type EmailStatus,
  type EmailType,
  type PatientLite,
} from "./types";

export const PAGE_SIZE = 50;
const EXPORT_CAP = 10_000;

const SELECT =
  "id, action, patient_id, resource_type, resource_id, metadata, created_at";

// Map a UI type filter to the underlying audit actions.
const ACTIONS_FOR_TYPE: Record<EmailType, string[]> = {
  result: ["result.notified"],
  booking: ["appointment.booked.notified"],
  reminder: ["appointment.reminder.sent", "appointment.reminder.failed"],
  newsletter: ["newsletter.campaign.sent"],
  registration_new: ["patient.self_registered"],
  registration_existing: ["patient.self_register.matched"],
};

// Manila is UTC+8, no DST. Accept a YYYY-MM-DD date input as a Manila local date.
function manilaStartUtc(d: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00+08:00` : null;
}
function manilaEndUtc(d: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T23:59:59.999+08:00` : null;
}

export interface EmailLogFilters {
  type: EmailType | null;
  status: EmailStatus | null; // "sent" | "failed" | "no_email" (bulk not a filter)
  drmId: string | null;
  since: string | null; // YYYY-MM-DD
  until: string | null;
  page: number;
}

type AdminClient = ReturnType<typeof createAdminClient>;

// Resolve a DRM-ID filter to a patient_id. Returns:
//  - { id }            → filter to this patient
//  - { id: SENTINEL }  → DRM provided but no match → force an empty result
//  - null              → no DRM filter
const NO_MATCH = "00000000-0000-0000-0000-000000000000";

async function resolvePatientFilter(
  admin: AdminClient,
  drmId: string | null,
): Promise<{ patientId: string | null; resolvedDrmId: string | null }> {
  if (!drmId || drmId.trim().length === 0) {
    return { patientId: null, resolvedDrmId: null };
  }
  const { data } = await admin
    .from("patients")
    .select("id, drm_id")
    .eq("drm_id", drmId.trim().toUpperCase())
    .maybeSingle();
  return data
    ? { patientId: data.id, resolvedDrmId: data.drm_id }
    : { patientId: NO_MATCH, resolvedDrmId: null };
}

// Apply the shared filters (action set, patient, date, status) to a query.
// PostgREST builder types don't compose cleanly across select/head variants,
// so we use `any` here to keep the helper generic without fighting the type system.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyFilters(query: any, filters: EmailLogFilters, patientId: string | null): any {
  const actions = filters.type ? ACTIONS_FOR_TYPE[filters.type] : [...EMAIL_ACTIONS];
  let q = query.in("action", actions);
  if (patientId) q = q.eq("patient_id", patientId);

  const since = filters.since ? manilaStartUtc(filters.since) : null;
  const until = filters.until ? manilaEndUtc(filters.until) : null;
  if (since) q = q.gte("created_at", since);
  if (until) q = q.lte("created_at", until);

  // Status is derived from metadata.email JSONB. Newsletter rows have no
  // metadata.email, so any status filter naturally excludes them.
  if (filters.status === "sent") {
    q = q.eq("metadata->email->>ok", "true");
  } else if (filters.status === "no_email") {
    q = q.eq("metadata->email->>skipped", "true");
  } else if (filters.status === "failed") {
    q = q.or(
      "metadata->email->>error.not.is.null,action.eq.appointment.reminder.failed",
    );
  }
  return q;
}

async function resolvePatients(
  admin: AdminClient,
  rows: EmailAuditRow[],
): Promise<Map<string, PatientLite>> {
  const ids = Array.from(
    new Set(rows.map((r) => r.patient_id).filter((x): x is string => !!x)),
  );
  const map = new Map<string, PatientLite>();
  if (ids.length === 0) return map;
  const { data } = await admin
    .from("patients")
    .select("id, drm_id, first_name, middle_name, last_name, email")
    .in("id", ids);
  for (const p of data ?? []) map.set(p.id, p as PatientLite);
  return map;
}

export interface EmailLogResult {
  entries: EmailLogEntry[];
  total: number;
  failures7d: number;
  // Manila date (YYYY-MM-DD) 7 days ago — the start of the failures7d window.
  // The banner links to ?status=failed&since=<this> so the count and the
  // linked view describe exactly the same set.
  since7Date: string;
  resolvedDrmId: string | null;
  drmNoMatch: boolean;
}

export async function fetchEmailLog(filters: EmailLogFilters): Promise<EmailLogResult> {
  const admin = createAdminClient();
  const { patientId, resolvedDrmId } = await resolvePatientFilter(admin, filters.drmId);
  const drmNoMatch = patientId === NO_MATCH;

  const offset = (filters.page - 1) * PAGE_SIZE;
  const base = admin
    .from("audit_log")
    .select(SELECT, { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  // The failures-7d banner count is a global heads-up (all types, all patients)
  // over the last 7 Manila days. It's independent of the page query, so run
  // both concurrently. Date.now() is fine in route/RSC code.
  const since7Date = new Date(Date.now() - 7 * 86_400_000).toLocaleDateString(
    "en-CA",
    { timeZone: "Asia/Manila" },
  );
  const [main, fails] = await Promise.all([
    applyFilters(base, filters, patientId),
    admin
      .from("audit_log")
      .select("id", { count: "exact", head: true })
      .in("action", [...EMAIL_ACTIONS])
      .gte("created_at", manilaStartUtc(since7Date)!)
      .or("metadata->email->>error.not.is.null,action.eq.appointment.reminder.failed"),
  ]);

  const rows = (main.data ?? []) as unknown as EmailAuditRow[];
  const patients = await resolvePatients(admin, rows);
  const entries = rows.map((r) =>
    parseEmailLogRow(r, r.patient_id ? patients.get(r.patient_id) ?? null : null),
  );

  return {
    entries,
    total: main.count ?? 0,
    failures7d: fails.count ?? 0,
    since7Date,
    resolvedDrmId,
    drmNoMatch,
  };
}

// Full filtered set for CSV export (capped). No pagination.
export async function fetchEmailLogForExport(
  filters: Omit<EmailLogFilters, "page">,
): Promise<EmailLogEntry[]> {
  const admin = createAdminClient();
  const { patientId } = await resolvePatientFilter(admin, filters.drmId);

  const base = admin
    .from("audit_log")
    .select(SELECT)
    .order("created_at", { ascending: false })
    .range(0, EXPORT_CAP - 1);

  const { data } = await applyFilters(base, { ...filters, page: 1 }, patientId);
  const rows = (data ?? []) as unknown as EmailAuditRow[];
  const patients = await resolvePatients(admin, rows);
  return rows.map((r) =>
    parseEmailLogRow(r, r.patient_id ? patients.get(r.patient_id) ?? null : null),
  );
}
