import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { appendRowsToTab } from "./google-sheets";
import {
  mapConsultRow,
  mapLabRow,
  mapProcedureRow,
  type ConsultRowSource,
  type LabRowSource,
  type ProcedureRowSource,
} from "./mappers";
import {
  type AccountingEnv,
  type SheetRow,
  type SyncResult,
  type TabConfig,
  type TabKey,
  type TabSyncResult,
} from "./types";

const TAB_CONFIGS: TabConfig[] = [
  {
    key: "lab_services",
    envTabName: "ACCOUNTING_TAB_LAB",
    label: "Lab Services",
    watermarkSource: "released_at",
  },
  {
    key: "doctor_consultations",
    envTabName: "ACCOUNTING_TAB_CONSULT",
    label: "Doctor Consultations",
    watermarkSource: "visit_created_at",
  },
  {
    key: "doctor_procedures",
    envTabName: "ACCOUNTING_TAB_PROCEDURE",
    label: "Doctor Procedures HMO",
    watermarkSource: "visit_created_at",
  },
];

// Default watermark when sync_state has no row for a key — start 24h back so
// the first run picks up yesterday's activity. Phase 8 may shorten this once
// continuous operation is verified.
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export function readAccountingEnv(): AccountingEnv | { missing: string[] } {
  const required: Array<keyof AccountingEnv | string> = [
    "GOOGLE_SERVICE_ACCOUNT_JSON",
    "ACCOUNTING_SHEET_ID",
    "ACCOUNTING_TAB_LAB",
    "ACCOUNTING_TAB_CONSULT",
    "ACCOUNTING_TAB_PROCEDURE",
  ];
  const missing = required.filter((k) => !process.env[k as string]);
  if (missing.length > 0) return { missing };
  return {
    serviceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON!,
    sheetId: process.env.ACCOUNTING_SHEET_ID!,
    tabLab: process.env.ACCOUNTING_TAB_LAB!,
    tabConsult: process.env.ACCOUNTING_TAB_CONSULT!,
    tabProcedure: process.env.ACCOUNTING_TAB_PROCEDURE!,
  };
}

function tabName(env: AccountingEnv, key: TabKey): string {
  switch (key) {
    case "lab_services":
      return env.tabLab;
    case "doctor_consultations":
      return env.tabConsult;
    case "doctor_procedures":
      return env.tabProcedure;
  }
}

interface SupabaseAdmin {
  from: ReturnType<typeof createAdminClient>["from"];
}

async function readWatermark(
  admin: SupabaseAdmin,
  key: TabKey,
): Promise<string> {
  const { data } = await admin
    .from("sync_state")
    .select("last_synced_at")
    .eq("key", key)
    .maybeSingle();
  return data?.last_synced_at ?? new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString();
}

async function writeWatermark(
  admin: SupabaseAdmin,
  key: TabKey,
  watermark: string,
  notes?: string,
): Promise<void> {
  await admin
    .from("sync_state")
    .upsert(
      {
        key,
        last_synced_at: watermark,
        notes: notes ?? null,
      },
      { onConflict: "key" },
    );
}

// =============================================================================
// Per-tab fetchers — return rows already shaped for the mapper.
// All three select shape uses Supabase's foreign-key join syntax against the
// linked `Database` type. RLS is bypassed by the service-role client.
// =============================================================================

interface RawTestRequest {
  id: string;
  test_number: number | null;
  base_price_php: number | null;
  discount_kind: string | null;
  discount_amount_php: number;
  final_price_php: number | null;
  clinic_fee_php: number | null;
  hmo_approved_amount_php: number | null;
  release_medium: string | null;
  released_at: string | null;
  receptionist_remarks: string | null;
  procedure_description: string | null;
  visits: {
    visit_date: string;
    visit_number: string;
    payment_status: string;
    hmo_approval_date: string | null;
    created_at: string;
    patients: {
      first_name: string;
      middle_name: string | null;
      last_name: string;
    } | null;
    hmo_providers: { name: string } | null;
    payments: Array<{ method: string | null; reference_number: string | null }> | null;
  } | null;
  services: { name: string; kind: string } | null;
}

function fullName(p: { first_name: string; middle_name: string | null; last_name: string } | null): string {
  if (!p) return "";
  const middle = p.middle_name ? ` ${p.middle_name}` : "";
  return `${p.last_name}, ${p.first_name}${middle}`.trim();
}

type RawPayment = { method: string | null; reference_number: string | null };

function joinedMethods(payments: RawPayment[] | null): string {
  if (!payments) return "";
  return payments
    .map((p) => p.method ?? "")
    .filter(Boolean)
    .join("; ");
}

function joinedRefs(payments: RawPayment[] | null): string {
  if (!payments) return "";
  return payments
    .map((p) => p.reference_number ?? "")
    .filter(Boolean)
    .join("; ");
}

const TEST_REQUEST_SELECT = `
  id, test_number, base_price_php, discount_kind, discount_amount_php,
  final_price_php, clinic_fee_php, hmo_approved_amount_php, release_medium,
  released_at, receptionist_remarks, procedure_description,
  visits!inner (
    visit_date, visit_number, payment_status, hmo_approval_date, created_at,
    patients!inner ( first_name, middle_name, last_name ),
    hmo_providers ( name ),
    payments ( method, reference_number )
  ),
  services!inner ( name, kind )
`;

const LAB_KINDS = ["lab_test", "lab_package", "vaccine", "home_service"];
const CONSULT_KINDS = ["doctor_consultation"];
const PROCEDURE_KINDS = ["doctor_procedure"];

async function fetchLabRows(
  admin: SupabaseAdmin,
  watermark: string,
): Promise<{ rows: SheetRow[]; maxTimestamp: string | null }> {
  const { data, error } = await admin
    .from("test_requests")
    .select(TEST_REQUEST_SELECT)
    .in("services.kind", LAB_KINDS)
    .gt("released_at", watermark)
    .not("released_at", "is", null)
    .order("released_at", { ascending: true })
    .returns<RawTestRequest[]>();

  if (error) throw new Error(`fetchLabRows: ${error.message}`);

  let maxTimestamp: string | null = null;
  const rows: SheetRow[] = [];
  for (const tr of data ?? []) {
    if (!tr.visits || !tr.services) continue;
    if (tr.released_at && (!maxTimestamp || tr.released_at > maxTimestamp)) {
      maxTimestamp = tr.released_at;
    }
    const source: LabRowSource = {
      visit_date: tr.visits.visit_date,
      visit_number: tr.visits.visit_number,
      patient_full_name: fullName(tr.visits.patients),
      hmo_provider_name: tr.visits.hmo_providers?.name ?? null,
      hmo_approval_date: tr.visits.hmo_approval_date,
      service_name: tr.services.name,
      base_price_php: tr.base_price_php,
      discount_kind: tr.discount_kind,
      discount_amount_php: tr.discount_amount_php,
      final_price_php: tr.final_price_php,
      payment_methods: joinedMethods(tr.visits.payments),
      payment_references: joinedRefs(tr.visits.payments),
      release_medium: tr.release_medium,
      released_at: tr.released_at,
      receptionist_remarks: tr.receptionist_remarks,
    };
    rows.push(mapLabRow(source));
  }
  return { rows, maxTimestamp };
}

async function fetchConsultRows(
  admin: SupabaseAdmin,
  watermark: string,
): Promise<{ rows: SheetRow[]; maxTimestamp: string | null }> {
  const { data, error } = await admin
    .from("test_requests")
    .select(TEST_REQUEST_SELECT)
    .in("services.kind", CONSULT_KINDS)
    .gt("visits.created_at", watermark)
    .order("visits(created_at)", { ascending: true })
    .returns<RawTestRequest[]>();

  if (error) throw new Error(`fetchConsultRows: ${error.message}`);

  let maxTimestamp: string | null = null;
  const rows: SheetRow[] = [];
  for (const tr of data ?? []) {
    if (!tr.visits || !tr.services) continue;
    const ts = tr.visits.created_at;
    if (ts && (!maxTimestamp || ts > maxTimestamp)) maxTimestamp = ts;
    const source: ConsultRowSource = {
      visit_number: tr.visits.visit_number,
      test_number: tr.test_number,
      patient_full_name: fullName(tr.visits.patients),
      hmo_provider_name: tr.visits.hmo_providers?.name ?? null,
      hmo_approval_date: tr.visits.hmo_approval_date,
      doctor_consultant: null,
      base_price_php: tr.base_price_php,
      discount_kind: tr.discount_kind,
      discount_amount_php: tr.discount_amount_php,
      final_price_php: tr.final_price_php,
      clinic_fee_php: tr.clinic_fee_php,
      payment_status: tr.visits.payment_status,
      payment_references: joinedRefs(tr.visits.payments),
      receptionist_remarks: tr.receptionist_remarks,
    };
    rows.push(mapConsultRow(source));
  }
  return { rows, maxTimestamp };
}

async function fetchProcedureRows(
  admin: SupabaseAdmin,
  watermark: string,
): Promise<{ rows: SheetRow[]; maxTimestamp: string | null }> {
  const { data, error } = await admin
    .from("test_requests")
    .select(TEST_REQUEST_SELECT)
    .in("services.kind", PROCEDURE_KINDS)
    .gt("visits.created_at", watermark)
    .order("visits(created_at)", { ascending: true })
    .returns<RawTestRequest[]>();

  if (error) throw new Error(`fetchProcedureRows: ${error.message}`);

  let maxTimestamp: string | null = null;
  const rows: SheetRow[] = [];
  for (const tr of data ?? []) {
    if (!tr.visits || !tr.services) continue;
    const ts = tr.visits.created_at;
    if (ts && (!maxTimestamp || ts > maxTimestamp)) maxTimestamp = ts;
    const source: ProcedureRowSource = {
      visit_date: tr.visits.visit_date,
      patient_full_name: fullName(tr.visits.patients),
      hmo_provider_name: tr.visits.hmo_providers?.name ?? null,
      hmo_approval_date: tr.visits.hmo_approval_date,
      procedure_description: tr.procedure_description,
      doctor_consultant: null,
      hmo_approved_amount_php: tr.hmo_approved_amount_php,
    };
    rows.push(mapProcedureRow(source));
  }
  return { rows, maxTimestamp };
}

// =============================================================================
// Orchestrator — wraps a full sync, audit-logs the outcome.
// =============================================================================

export interface RunSyncOptions {
  trigger: "cron" | "manual";
  // Optional: restrict the run to one tab. Defaults to all three.
  onlyKey?: TabKey;
  // When set, the actor whose action triggered the sync (manual re-sync only).
  actorId?: string | null;
}

export async function runAccountingSync(opts: RunSyncOptions): Promise<SyncResult> {
  const startedAt = new Date().toISOString();
  const env = readAccountingEnv();
  const tabsToRun = opts.onlyKey
    ? TAB_CONFIGS.filter((t) => t.key === opts.onlyKey)
    : TAB_CONFIGS;

  if ("missing" in env) {
    const tabs: TabSyncResult[] = tabsToRun.map((t) => ({
      key: t.key,
      label: t.label,
      rowsAppended: 0,
      watermarkBefore: "",
      watermarkAfter: "",
      skippedReason: `missing env: ${env.missing.join(", ")}`,
    }));
    const finishedAt = new Date().toISOString();
    await audit({
      actor_id: opts.actorId ?? null,
      actor_type: opts.trigger === "cron" ? "system" : "staff",
      action: "accounting.sync.skipped",
      metadata: { reason: "missing_env", missing: env.missing },
    });
    return { startedAt, finishedAt, tabs, totalRowsAppended: 0 };
  }

  const admin = createAdminClient();
  const tabResults: TabSyncResult[] = [];

  for (const t of tabsToRun) {
    const before = await readWatermark(admin, t.key);
    let fetched: { rows: SheetRow[]; maxTimestamp: string | null };
    try {
      fetched =
        t.key === "lab_services"
          ? await fetchLabRows(admin, before)
          : t.key === "doctor_consultations"
          ? await fetchConsultRows(admin, before)
          : await fetchProcedureRows(admin, before);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      tabResults.push({
        key: t.key,
        label: t.label,
        rowsAppended: 0,
        watermarkBefore: before,
        watermarkAfter: before,
        skippedReason: `fetch failed: ${message}`,
      });
      continue;
    }

    if (fetched.rows.length === 0) {
      tabResults.push({
        key: t.key,
        label: t.label,
        rowsAppended: 0,
        watermarkBefore: before,
        watermarkAfter: before,
      });
      continue;
    }

    try {
      await appendRowsToTab({
        serviceAccountJson: env.serviceAccountJson,
        sheetId: env.sheetId,
        tabName: tabName(env, t.key),
        rows: fetched.rows,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      tabResults.push({
        key: t.key,
        label: t.label,
        rowsAppended: 0,
        watermarkBefore: before,
        watermarkAfter: before,
        skippedReason: `append failed: ${message}`,
      });
      continue;
    }

    const after = fetched.maxTimestamp ?? before;
    await writeWatermark(admin, t.key, after);
    tabResults.push({
      key: t.key,
      label: t.label,
      rowsAppended: fetched.rows.length,
      watermarkBefore: before,
      watermarkAfter: after,
    });
  }

  const finishedAt = new Date().toISOString();
  const total = tabResults.reduce((sum, t) => sum + t.rowsAppended, 0);

  await audit({
    actor_id: opts.actorId ?? null,
    actor_type: opts.trigger === "cron" ? "system" : "staff",
    action: total > 0 ? "accounting.sync.completed" : "accounting.sync.empty",
    metadata: {
      trigger: opts.trigger,
      onlyKey: opts.onlyKey ?? null,
      tabs: tabResults.map((t) => ({
        key: t.key,
        rows: t.rowsAppended,
        skipped: t.skippedReason ?? null,
      })),
    },
  });

  return { startedAt, finishedAt, tabs: tabResults, totalRowsAppended: total };
}

// Used by the admin "Re-sync from date X" flow: rewinds the watermark for one
// or all tabs before the caller re-runs the sync.
export async function rewindWatermark(
  key: TabKey | "all",
  to: string,
  notes?: string,
): Promise<void> {
  const admin = createAdminClient();
  const keys: TabKey[] =
    key === "all" ? TAB_CONFIGS.map((t) => t.key) : [key];
  for (const k of keys) {
    await writeWatermark(admin, k, to, notes);
  }
}

export async function readAllWatermarks(): Promise<
  Array<{ key: TabKey; label: string; lastSyncedAt: string | null; notes: string | null }>
> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("sync_state")
    .select("key, last_synced_at, notes");
  const byKey = new Map<string, { last_synced_at: string; notes: string | null }>();
  for (const r of data ?? []) {
    byKey.set(r.key, { last_synced_at: r.last_synced_at, notes: r.notes });
  }
  return TAB_CONFIGS.map((t) => {
    const row = byKey.get(t.key);
    return {
      key: t.key,
      label: t.label,
      lastSyncedAt: row?.last_synced_at ?? null,
      notes: row?.notes ?? null,
    };
  });
}
