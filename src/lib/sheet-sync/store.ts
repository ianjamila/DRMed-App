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

/**
 * One page of `sheet_sync_revert_run` (migration round 5, 0170): counts are
 * PER CALL, not cumulative — a caller paging through must sum them itself.
 * `done` is true only on the call that found nothing left to undo; only that
 * call also holds the run's own links, restores/removes its alias, and marks
 * the run reverted, so `links_left` / `alias_removed` / `alias_restored` are
 * always 0 on every earlier page.
 */
export interface RevertPageResult {
  done: boolean;
  restored: number;
  blocked: number;
  deleted: number;
  kept: number;
  held: number;
  links_left: number;
  alias_removed: number;
  alias_restored: number;
  /** Created patients already gone (removed by staff) when the undo reached them. */
  gone: number;
}

/**
 * One page of `sheet_sync_release_undo` ("Let the sync decide again", 0170):
 * PER CALL counts — holds released and review items resolved as released.
 * `done` is true only on the call that found none of that undo's holds left
 * (it also marks the undo run(s) released).
 */
export interface ReleasePageResult {
  done: boolean;
  released: number;
  items_resolved: number;
}

export type SyncTrigger = "cron" | "manual" | "cli" | "resort" | "alias" | "revert" | "release";

export interface SheetSyncStore {
  acquire(trigger: SyncTrigger, actorId: string | null, dryRun: boolean): Promise<AcquireResult>;
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
  /**
   * `itemId` (0170's p_item_id, map-answer race, Codex P2): fences this call
   * to that exact review item, atomically with the lease/write this already
   * holds. A second admin racing to map the same answer gets P0064 instead
   * of silently overwriting the first admin's channel choice.
   */
  aliasApply(lease: string, answerNorm: string, sourceId: string, actorId: string, itemId: string): Promise<number>;
  /** `limit` bounds patients handled THIS call (0170's p_limit); omit it to undo everything in one call. */
  revertRun(lease: string, targetRunId: string, limit?: number): Promise<RevertPageResult>;
  /** `limit` bounds holds released THIS call (0170's p_limit); omit it to release them all in one call. */
  releaseUndo(lease: string, undoRunId: string, limit?: number): Promise<ReleasePageResult>;
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

// One string literal (not `+`-concatenated) so query-surfaces.test.ts's static
// scanner — which only resolves a plain string/no-substitution-template
// constant, not a concatenation — can see deleted_at and merged_into_id in it.
const PATIENT_COLUMNS = "id, drm_id, first_name, middle_name, last_name, birthdate, phone, phone_normalized, email, sex, address, referred_by_doctor, preferred_release_medium, senior_pwd_id_kind, senior_pwd_id_number, referral_source, referral_source_origin, deleted_at, merged_into_id, row_version";

/** Review items per sheet_sync_upsert_review call (see upsertReview below). */
export const REVIEW_CHUNK = 1000;

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
    // 0167 (patient soft delete) landed: excludes deleted rows so the sync
    // never links to or fills one — but NOT merged_into_id, since the planner
    // still needs a merged patient to resolve a link to its survivor
    // (query-surfaces.test.ts classifies this as "lifecycle": it selects both
    // deleted_at and merged_into_id and makes that active/merged decision).
    loadPatients: () => all<PatientRecord>((from, to) =>
      client.from("patients").select(PATIENT_COLUMNS).is("deleted_at", null).order("id").range(from, to) as never),
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
    // Chunked (REVIEW_CHUNK items a call): one item costs a few indexed
    // lookups, and the first sync after undoing a catch-up run reports ~4.8k
    // items — a single call measured 4.6 s locally, too close to the 8 s
    // statement_timeout. Clearing absent items needs the WHOLE list, so it
    // runs once at the end, set-based (sheet_sync_clear_absent_review, 0170).
    async upsertReview(lease, tab, items, clearAbsent) {
      const counts: Record<string, number> = {};
      for (let i = 0; i < items.length; i += REVIEW_CHUNK) {
        const res = await rpc<Record<string, number>>("sheet_sync_upsert_review",
          { p_lease_token: lease, p_tab: tab, p_items: items.slice(i, i + REVIEW_CHUNK), p_clear_absent: false });
        for (const [k, v] of Object.entries(res)) counts[k] = (counts[k] ?? 0) + v;
      }
      if (clearAbsent) {
        counts.cleared = (counts.cleared ?? 0) + await rpc<number>("sheet_sync_clear_absent_review",
          { p_lease_token: lease, p_tab: tab, p_present: items.map((it) => ({ kind: it.kind, item_key: it.item_key })) });
      }
      return counts;
    },
    resortApply: (lease, ids, expectedOld, next) =>
      rpc("sheet_resort_apply", { p_lease_token: lease, p_patient_ids: ids, p_expected_old: expectedOld, p_new: next }),
    aliasApply: (lease, answerNorm, sourceId, actorId, itemId) =>
      rpc("sheet_alias_apply", { p_lease_token: lease, p_raw_normalized: answerNorm, p_source_id: sourceId, p_actor: actorId, p_item_id: itemId }),
    revertRun: (lease, target, limit) =>
      rpc("sheet_sync_revert_run", { p_lease_token: lease, p_target_run: target, p_limit: limit ?? null }),
    releaseUndo: (lease, undoRun, limit) =>
      rpc("sheet_sync_release_undo", { p_lease_token: lease, p_undo_run: undoRun, p_limit: limit ?? null }),
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
