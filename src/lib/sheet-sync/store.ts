/**
 * SheetSyncStore: the interface `runSheetSync` (run.ts) talks to, plus the
 * Supabase implementation over the lease-fenced RPCs (migration 0170).
 * Pure and not server-only: the CLI imports the interface + a fake for tests;
 * only `createSupabaseStore` touches `@supabase/supabase-js`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "../reports/paging";
import type { Database, Json } from "../../types/database";
import type {
  CustomerOp, FactsRecord, LinkRecord, PatientRecord, PrevCustomerRow, ReviewItemInput, TabKey,
} from "./types";

export class SyncBusyError extends Error { constructor() { super("Another sheet sync is running."); this.name = "SyncBusyError"; } }
export class LeaseLostError extends Error { constructor() { super("This sheet sync lost its turn to another run."); this.name = "LeaseLostError"; } }

export type AcquireResult =
  | { status: "running"; runId: string; leaseToken: string }
  | { status: "skipped_paused"; runId: string };

export interface AuditRow {
  actor_id: string | null;
  actor_type: "staff" | "system";
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  metadata: Json;
}

export interface SheetSyncStore {
  acquire(trigger: "cron" | "manual" | "cli" | "resort" | "alias" | "revert", actorId: string | null, dryRun: boolean): Promise<AcquireResult>;
  heartbeat(lease: string): Promise<void>;
  finish(lease: string, status: "succeeded" | "partial" | "failed", perTab: Json, summary: Json, error: string | null): Promise<void>;
  readSettings(): Promise<{ paused: boolean; mirrorWindowStart: string }>;
  lastGoodRowsRead(): Promise<Partial<Record<TabKey, number>>>;
  isSuspectAccepted(tab: TabKey, rowsRead: number): Promise<boolean>;
  loadPatients(): Promise<PatientRecord[]>;
  loadLinks(): Promise<LinkRecord[]>;
  loadFacts(): Promise<FactsRecord[]>;
  loadAliases(): Promise<Map<string, string>>;
  loadCustomerMirror(): Promise<PrevCustomerRow[]>;
  applyCustomerOps(lease: string, ops: CustomerOp[]): Promise<{ created: Record<string, string>; counts: Record<string, number> }>;
  stage(lease: string, tab: TabKey, rows: Json[]): Promise<void>;
  commit(lease: string, tab: TabKey, expected: number): Promise<number>;
  upsertReview(lease: string, tab: TabKey, items: ReviewItemInput[], clearAbsent: boolean): Promise<Record<string, number>>;
  resortApply(lease: string, patientIds: string[], expectedOld: string | null, next: string | null): Promise<number>;
  aliasApply(lease: string, answerNorm: string, sourceId: string, actorId: string): Promise<number>;
  revertRun(lease: string, targetRunId: string): Promise<Record<string, number>>;
  reviewResolve(itemId: string, actorId: string, action: "link" | "create" | "dismiss", patientId: string | null): Promise<void>;
  resortCandidates(): Promise<Array<{ id: string; answer: string; referral_source: string | null; referral_source_origin: "staff" | "patient" | "sheet" | null }>>;
  audit(row: AuditRow): Promise<void>;
}

type Client = SupabaseClient<Database>;

/** Maps P0062/P0063 to typed errors; P0064 and everything else becomes a coded Error. */
function raise(error: { code?: string; message: string }): never {
  if (error.code === "P0062") throw new SyncBusyError();
  if (error.code === "P0063") throw new LeaseLostError();
  const e = new Error(error.message) as Error & { code?: string };
  e.code = error.code;
  throw e;
}

const PATIENT_COLUMNS = "id, drm_id, first_name, middle_name, last_name, birthdate, phone, phone_normalized, email, sex, " +
  "address, referred_by_doctor, preferred_release_medium, senior_pwd_id_kind, senior_pwd_id_number, referral_source, " +
  "referral_source_origin, merged_into_id";

const ALL = 200_000; // ceiling for the paged loaders — far above today's ~8k patients

export function createSupabaseStore(client: Client): SheetSyncStore {
  // RPC names/arg shapes (nullable P-code args, Json payloads) don't all line up with the
  // generated Database["public"]["Functions"] overloads; the `any` is contained to this call site.
  const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see comment above
    const { data, error } = await (client.rpc as any)(fn, args);
    if (error) raise(error);
    return data as T;
  };
  const all = async <T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) => {
    const { rows, truncated } = await fetchAllRows(page, ALL);
    if (truncated) throw new Error("Sheet sync loader hit its row ceiling");
    return rows;
  };
  return {
    async acquire(trigger, actorId, dryRun) {
      const r = await rpc<{ status: string; run_id: string; lease_token?: string }>("sheet_sync_acquire",
        { p_trigger: trigger, p_actor: actorId, p_dry_run: dryRun });
      return r.status === "running"
        ? { status: "running", runId: r.run_id, leaseToken: r.lease_token! }
        : { status: "skipped_paused", runId: r.run_id };
    },
    heartbeat: (lease) => rpc("sheet_sync_heartbeat", { p_lease_token: lease }),
    finish: (lease, status, perTab, summary, error) =>
      rpc("sheet_sync_finish", { p_lease_token: lease, p_status: status, p_per_tab: perTab, p_summary: summary, p_error: error }),
    async readSettings() {
      const { data, error } = await client.from("sheet_sync_settings").select("paused, mirror_window_start").eq("id", true).single();
      if (error) raise(error);
      return { paused: data.paused, mirrorWindowStart: data.mirror_window_start };
    },
    async lastGoodRowsRead() {
      // A "succeeded"/"partial" run can still have ONE tab that failed (e.g. lab
      // keeps hitting a header change while customers/consult are fine) — a flat
      // `.limit(30)` over the whole run history can then run out before it ever
      // finds a run where THAT tab succeeded, silently disabling its snapshot gate.
      // Page through run history instead, stopping once all three tabs are found
      // (the common case: one or two pages) or a generous cap is hit.
      const PAGE = 30;
      const MAX_PAGES = 20; // 600 runs — far more than a nightly cron could fail through before someone notices
      const out: Partial<Record<TabKey, number>> = {};
      for (let page = 0; page < MAX_PAGES; page++) {
        const { data, error } = await client.from("sheet_sync_runs").select("per_tab")
          .eq("dry_run", false).in("status", ["succeeded", "partial"])
          .order("started_at", { ascending: false }).order("id", { ascending: true })
          .range(page * PAGE, page * PAGE + PAGE - 1);
        if (error) raise(error);
        const rows = data ?? [];
        for (const row of rows) {
          const per = (row.per_tab ?? {}) as Record<string, { status?: string; rows_read?: number }>;
          for (const k of ["customers", "lab", "consult"] as TabKey[]) {
            if (out[k] === undefined && per[k]?.status === "succeeded" && typeof per[k]?.rows_read === "number") out[k] = per[k]!.rows_read;
          }
        }
        if (Object.keys(out).length === 3 || rows.length < PAGE) break;
      }
      return out;
    },
    async isSuspectAccepted(tab, rowsRead) {
      const { count, error } = await client.from("sheet_sync_review_items").select("id", { count: "exact", head: true })
        .eq("kind", "suspect_snapshot").eq("item_key", `${tab}:${rowsRead}`).eq("status", "dismissed");
      if (error) raise(error);
      return (count ?? 0) > 0;
    },
    // NOTE: no `.is("deleted_at", null)` — `patients.deleted_at` does not exist on
    // origin/main yet (migration 0167, branch feat/patient-delete, is parallel).
    // Add that filter here the moment patient soft delete lands, so the sync
    // never links to or fills a deleted patient (a merged patient must still be
    // loaded — the index needs it to resolve a link to its survivor).
    loadPatients: () => all<PatientRecord>((from, to) =>
      client.from("patients").select(PATIENT_COLUMNS).order("id").range(from, to) as never),
    loadLinks: () => all<LinkRecord>((from, to) =>
      client.from("sheet_patient_links").select("link_key, patient_id, decision, method, hold_reason").order("link_key").range(from, to) as never),
    loadFacts: () => all<FactsRecord>((from, to) =>
      client.from("patient_acquisition_facts").select("patient_id, registered_on, sheet_new_repeat, source_ref").order("patient_id").range(from, to) as never),
    async loadAliases() {
      const rows = await all<{ raw_normalized: string; referral_source_id: string }>((from, to) =>
        client.from("referral_source_aliases").select("raw_normalized, referral_source_id").order("raw_normalized").range(from, to) as never);
      return new Map(rows.map((r) => [r.raw_normalized, r.referral_source_id]));
    },
    loadCustomerMirror: () => all<PrevCustomerRow>((from, to) =>
      client.from("sheet_customer_rows").select("source_key, patient_id, phone_norm, dob, link_state").order("id").range(from, to) as never),
    applyCustomerOps: (lease, ops) => rpc("sheet_sync_apply_customer_ops", { p_lease_token: lease, p_ops: ops }),
    async stage(lease, tab, rows) { await rpc("sheet_mirror_stage", { p_lease_token: lease, p_tab: tab, p_rows: rows }); },
    commit: (lease, tab, expected) => rpc("sheet_mirror_commit", { p_lease_token: lease, p_tab: tab, p_expected: expected }),
    upsertReview: (lease, tab, items, clearAbsent) =>
      rpc("sheet_sync_upsert_review", { p_lease_token: lease, p_tab: tab, p_items: items, p_clear_absent: clearAbsent }),
    resortApply: (lease, ids, expectedOld, next) =>
      rpc("sheet_resort_apply", { p_lease_token: lease, p_patient_ids: ids, p_expected_old: expectedOld, p_new: next }),
    aliasApply: (lease, answerNorm, sourceId, actorId) =>
      rpc("sheet_alias_apply", { p_lease_token: lease, p_raw_normalized: answerNorm, p_source_id: sourceId, p_actor: actorId }),
    revertRun: (lease, target) => rpc("sheet_sync_revert_run", { p_lease_token: lease, p_target_run: target }),
    async reviewResolve(itemId, actorId, action, patientId) {
      await rpc("sheet_review_resolve", { p_item_id: itemId, p_actor: actorId, p_action: action, p_patient_id: patientId });
    },
    resortCandidates: () => all((from, to) => client.rpc("sheet_resort_candidates").range(from, to) as never),
    async audit(row) {
      const { error } = await client.from("audit_log").insert(row);
      if (error) console.error("sheet sync audit insert failed", { action: row.action, error: error.message });
    },
  };
}
