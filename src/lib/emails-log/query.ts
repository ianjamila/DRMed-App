import "server-only";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/reports/paging";
import { resolvePatientsByIdChunked } from "./resolve-patients";
import { parseEmailLogRow } from "./parse-row";
import { rangeFor, type SortSpec } from "@/lib/ui/table-params";
import {
  EMAIL_ACTIONS,
  type EmailAuditRow,
  type EmailLogEntry,
  type EmailStatus,
  type EmailType,
  type PatientLite,
} from "./types";

/** The page size this log has always defaulted to; the picker can override it. */
export const PAGE_SIZE = 50;

/**
 * Columns the log can be ordered by, and the allow-list `parseSort` checks —
 * the value reaches a PostgREST `.order()`, so it is a security boundary.
 *
 * Only two of the seven displayed columns are real `audit_log` columns.
 * Recipient and Email are resolved by a SECOND query after this window is
 * already fetched (the audit row carries a `patient_id`, not a name), and
 * Status is derived from the `metadata.email` JSONB by `parseEmailLogRow` —
 * none of the three can be expressed in this `.order()`, so the page renders
 * them with `PlainTh`.
 *
 * "Type" orders by the underlying `action`, which is what the type label is
 * derived from: the two reminder actions (sent / failed) sort together, and
 * the booking action sorts beside them.
 */
export const EMAIL_LOG_SORT_COLUMNS = ["created_at", "action"] as const;
export type EmailLogSortColumn = (typeof EMAIL_LOG_SORT_COLUMNS)[number];

/** Newest first — the order this page has always opened in. */
export const DEFAULT_EMAIL_LOG_SORT: SortSpec<EmailLogSortColumn> = {
  key: "created_at",
  dir: "desc",
};

// H8: the true row cap the export is allowed to reach. Previously requested
// via a single `.range(0, EXPORT_CAP - 1)`, which reads as "give me up to
// 10,000 rows" but PostgREST hard-caps ONE response at 1000 regardless of the
// range asked for — so the export silently stopped at 1000 with no signal,
// and the audit row recorded that short count as if it were the complete
// set. `fetchAllRows` (src/lib/reports/paging.ts) walks it in 1000-row pages
// up to this ceiling and reports whether it was actually reached.
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
  contact_alert: ["contact_message.alert_sent"],
};

// Manila is UTC+8, no DST. Accept a YYYY-MM-DD date input as a Manila local date.
function manilaStartUtc(d: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00+08:00` : null;
}
function manilaEndUtc(d: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T23:59:59.999+08:00` : null;
}

/** What both surfaces filter by. The page adds its own sort/page window. */
export interface EmailLogFilters {
  type: EmailType | null;
  status: EmailStatus | null; // "sent" | "failed" | "no_email" (bulk not a filter)
  drmId: string | null;
  since: string | null; // YYYY-MM-DD
  until: string | null;
}

/** One on-screen window of the log: the filters plus where to slice them. */
export interface EmailLogPageRequest extends EmailLogFilters {
  sort: SortSpec<EmailLogSortColumn>;
  page: number;
  size: number;
}

type RlsClient = Awaited<ReturnType<typeof createClient>>;

// Resolve a DRM-ID filter to a patient_id. Returns:
//  - { id }            → filter to this patient
//  - { id: SENTINEL }  → DRM provided but no match → force an empty result
//  - null              → no DRM filter
const NO_MATCH = "00000000-0000-0000-0000-000000000000";

async function resolvePatientFilter(
  supabase: RlsClient,
  drmId: string | null,
): Promise<{ patientId: string | null; resolvedDrmId: string | null }> {
  if (!drmId || drmId.trim().length === 0) {
    return { patientId: null, resolvedDrmId: null };
  }
  const { data } = await supabase
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

// N15: chunked past the 200-id-per-`.in()` and 1000-row PostgREST caps, and
// throws (rather than discarding) a failed chunk's error — see
// resolve-patients.ts. The export can walk up to EXPORT_CAP (10,000) audit
// rows, which can easily name more than 1000 distinct patients; the plain
// UI page (PAGE_SIZE = 50 rows) never approaches a second chunk, but shares
// the same, now-safe, code path.
async function resolvePatients(
  supabase: RlsClient,
  rows: EmailAuditRow[],
): Promise<Map<string, PatientLite>> {
  const ids = rows.map((r) => r.patient_id).filter((x): x is string => !!x);
  return resolvePatientsByIdChunked<PatientLite>(ids, async (idChunk) => {
    const { data, error } = await supabase
      .from("patients")
      .select("id, drm_id, first_name, middle_name, last_name, email")
      .in("id", [...idChunk]);
    return { data: data as PatientLite[] | null, error };
  });
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

export async function fetchEmailLog(
  request: EmailLogPageRequest,
): Promise<EmailLogResult> {
  const filters: EmailLogFilters = request;
  // M16: RLS-scoped client, not service-role — `audit_log: admin select` and
  // `patients: staff full` both let an admin staff JWT read what this page
  // needs; every caller is already behind requireAdminStaff().
  const supabase = await createClient();
  const { patientId, resolvedDrmId } = await resolvePatientFilter(supabase, filters.drmId);
  const drmNoMatch = patientId === NO_MATCH;

  const [from, to] = rangeFor(request.page, request.size);
  const base = supabase
    .from("audit_log")
    .select(SELECT, { count: "exact" })
    .order(request.sort.key, { ascending: request.sort.dir === "asc" })
    // Tie-break on id — a bulk send writes many rows in the same millisecond,
    // and ordering by `action` ties across thousands, so without a total
    // order `.range()` drops and repeats rows between pages. Descending, to
    // match the export below: same column, same direction, one reading order.
    .order("id", { ascending: false })
    .range(from, to);

  // The failures-7d banner count is a global heads-up (all types, all patients)
  // over the last 7 Manila days. It's independent of the page query, so run
  // both concurrently. Date.now() is fine in route/RSC code.
  const since7Date = new Date(Date.now() - 7 * 86_400_000).toLocaleDateString(
    "en-CA",
    { timeZone: "Asia/Manila" },
  );
  const [main, fails] = await Promise.all([
    applyFilters(base, filters, patientId),
    supabase
      .from("audit_log")
      .select("id", { count: "exact", head: true })
      .in("action", [...EMAIL_ACTIONS])
      .gte("created_at", manilaStartUtc(since7Date)!)
      .or("metadata->email->>error.not.is.null,action.eq.appointment.reminder.failed"),
  ]);

  const rows = (main.data ?? []) as unknown as EmailAuditRow[];
  const patients = await resolvePatients(supabase, rows);
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

export interface EmailLogExportResult {
  entries: EmailLogEntry[];
  // H8: true when the filtered set exceeds EXPORT_CAP — the export stopped
  // there, and the caller must say so rather than letting the file (or its
  // audit row) read as complete.
  truncated: boolean;
}

// Full filtered set for CSV export (capped). No UI pagination — but the set
// itself is walked in PostgREST-sized pages under the hood (H8).
export async function fetchEmailLogForExport(
  filters: EmailLogFilters,
): Promise<EmailLogExportResult> {
  // M16: RLS-scoped client — see fetchEmailLog.
  const supabase = await createClient();
  const { patientId } = await resolvePatientFilter(supabase, filters.drmId);

  // H8: PostgREST hard-caps ONE response at 1000 rows no matter what range is
  // requested, so a single `.range(0, EXPORT_CAP - 1)` silently returned at
  // most 1000 rows. `fetchAllRows` walks it in PostgREST's 1000-row pages
  // (its own PAGE_SIZE, distinct from this file's 50-row UI PAGE_SIZE) up to
  // EXPORT_CAP — `created_at` ties (bulk sends can share a millisecond) are
  // broken by `id` so the paged order stays total and no row is skipped or
  // repeated.
  const { rows, truncated } = await fetchAllRows<EmailAuditRow>(
    (from, to) => {
      const base = supabase
        .from("audit_log")
        .select(SELECT)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false });
      return applyFilters(base, filters, patientId).range(from, to);
    },
    EXPORT_CAP,
  );

  const patients = await resolvePatients(supabase, rows);
  const entries = rows.map((r) =>
    parseEmailLogRow(r, r.patient_id ? patients.get(r.patient_id) ?? null : null),
  );
  return { entries, truncated };
}
