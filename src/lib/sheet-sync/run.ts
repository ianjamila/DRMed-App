import { todayManilaISODate } from "../dates/manila";
import type { Json } from "../../types/database";
import { planCustomers } from "./customer-plan";
import { assignIdentities, type IdentifiedLine } from "./encounter-identity";
import { buildPatientIndex, type PatientIndex } from "./patient-index";
import { checkSnapshot } from "./snapshot";
import { LeaseLostError, SyncBusyError, type ReleasePageResult, type RevertPageResult, type SheetSyncStore } from "./store";
import { parseCustomersTab } from "./tabs/customers";
import { parseConsultTab, parseLabTab } from "./tabs/encounters";
import type { CustomerMirrorRow, CustomerOp, LinkRecord, RawTabs, TabKey, TabParse } from "./types";

export const OPS_CHUNK = 500;
export const STAGE_CHUNK = 2000;

export type RunTrigger = "cron" | "manual" | "cli";
export interface TabOutcome {
  status: "succeeded" | "failed" | "skipped";
  rows_read?: number;
  last_date?: string | null;
  undated?: number;
  planned?: Record<string, unknown>;
  applied?: Record<string, number>;
  mirror_rows?: number;
  review?: Record<string, number>;
  error?: string;
}
export interface RunOutcome {
  runId: string | null;
  status: "skipped_paused" | "succeeded" | "partial" | "failed";
  perTab: Partial<Record<TabKey, TabOutcome>>;
  durationMs: number;
  error?: string;
}

const chunks = <T>(a: readonly T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const countKinds = (items: { kind: string }[]) => items.reduce<Record<string, number>>((m, i) => ((m[i.kind] = (m[i.kind] ?? 0) + 1), m), {});

/** Our own errors (P00NN and 22023, always hand-authored short strings) are safe to
 * surface; anything else carrying a foreign SQLSTATE (e.g. Postgres's own
 * invalid_text_representation, which echoes the bad value) can leak row data into
 * per_tab.error / sheet_sync_runs.error, both of which end up in run history and
 * Sentry breadcrumbs. Redact those to the bare code and log the real message
 * server-side only. */
const OUR_CODE = /^(P006[2-4]|22023)$/i;
function errText(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as Error & { code?: string }).code;
    if (code && !OUR_CODE.test(code)) {
      // The message itself is withheld: a foreign SQLSTATE (22P02, 23505, …)
      // routinely echoes the offending cell value, and console.error is a
      // Sentry breadcrumb — logging it would leak patient data into Sentry
      // the same way it would into per_tab.error. Only the code is safe.
      console.error("sheet sync: redacted database error — message withheld (may contain sheet data)", { code });
      return `database error ${code}`;
    }
    return e.message;
  }
  return String(e);
}

/** Shown on lab/consult when a partial Customers failure left identity data
 * possibly stale and the post-failure reload (below) could not refresh it —
 * never a good idea to resolve names against patients/links that predate a
 * hold or create this run already committed. */
const IDENTITY_STALE_MESSAGE = "Skipped because the patient list could not be refreshed after a partial Customers update.";

function lineToRow(l: IdentifiedLine): Json {
  return {
    sheet_row: l.sheetRow, service_date: l.serviceDate, name_raw: l.nameRaw, name_norm: l.nameNorm, loose_key: l.looseKey,
    patient_id: l.patientId, identity_key: l.identityKey, service_raw: l.serviceRaw, doctor_raw: l.doctorRaw,
    hmo_raw: l.hmoRaw, base_php: l.basePhp, final_php: l.finalPhp, clinic_fee_php: l.clinicFeePhp, revenue_php: l.revenuePhp,
    payment_method_raw: l.paymentMethodRaw, payment_detail_raw: l.paymentDetailRaw, release_medium_raw: l.releaseMediumRaw,
    released_on: l.releasedOn, control_no: l.controlNo, test_no: l.testNo, raw: l.raw as Json, row_hash: l.rowHash,
  };
}

export async function runSheetSync(opts: {
  store: SheetSyncStore;
  readSheet: () => Promise<RawTabs>;
  trigger: RunTrigger;
  actorId: string | null;
  dryRun: boolean;
  today?: string;
  now?: () => number;
}): Promise<RunOutcome> {
  const { store } = opts;
  const now = opts.now ?? Date.now;
  const started = now();
  const today = opts.today ?? todayManilaISODate();
  // cli runs (scripts/sheet-sync.ts) have no admin actor either — audit them
  // as 'system' like cron, not 'staff' with a null id.
  const actorType = opts.trigger === "cron" || opts.trigger === "cli" ? "system" : "staff";
  const audit = (action: string, runId: string | null, metadata: Record<string, unknown>) =>
    store.audit({ actor_id: opts.actorId, actor_type: actorType, action, resource_type: "sheet_sync_run", resource_id: runId, metadata: metadata as Json });

  const acq = await store.acquire(opts.trigger, opts.actorId, opts.dryRun); // SyncBusyError propagates
  if (acq.status === "skipped_paused") {
    await audit("sheet_sync.skipped", acq.runId, { reason: "paused", trigger: opts.trigger });
    return { runId: acq.runId, status: "skipped_paused", perTab: {}, durationMs: now() - started };
  }
  const lease = acq.leaseToken;
  const perTab: Partial<Record<TabKey, TabOutcome>> = {};
  let status: RunOutcome["status"];

  try {
    const [raw, settings, lastGood, patients, linkRows, factRows, aliases, prevMirror, deletedPatients] = await Promise.all([
      opts.readSheet(), store.readSettings(), store.lastGoodRowsRead(), store.loadPatients(), store.loadLinks(),
      store.loadFacts(), store.loadAliases(), store.loadCustomerMirror(), store.loadDeletedPatients(),
    ]);
    // The initial load (a full patients table, etc.) can itself take a while on
    // a large clinic — refresh the lease before spending more time planning.
    await store.heartbeat(lease);
    let index: PatientIndex = buildPatientIndex(patients);
    const links = new Map<string, LinkRecord>(linkRows.map((l) => [l.link_key, l]));
    const facts = new Map(factRows.map((f) => [f.patient_id, f]));
    // Set when a Customers ops chunk committed (a hold/create/link/fill) and a
    // LATER chunk then failed, so the reload below (which normally runs right
    // after every chunk applies) never ran — links/index can now disagree with
    // what the database actually holds. Checked before lab/consult resolve
    // identity: running them against stale state could link/unlink the wrong
    // person, which is worse than skipping them for this run.
    let identityStale = false;

    /** Shared snapshot gate: false ⇒ tab skipped as suspect (item raised when not dry). */
    const snapshotOk = async (tab: TabKey, parsed: TabParse<unknown>) => {
      const snap = checkSnapshot(parsed.rowsRead, lastGood[tab]);
      if (!snap.suspect || (await store.isSuspectAccepted(tab, parsed.rowsRead))) return true;
      perTab[tab] = { status: "failed", rows_read: parsed.rowsRead, error: `suspect_snapshot: ${snap.previous} → ${snap.current} rows (−${snap.shrinkPct}%)` };
      if (!opts.dryRun) {
        await store.upsertReview(lease, tab, [{ kind: "suspect_snapshot", item_key: `${tab}:${parsed.rowsRead}`,
          payload: { tab, previous: snap.previous, current: snap.current, shrink_pct: snap.shrinkPct } }], false);
      }
      return false;
    };

    // Customers
    try {
      const parsed = parseCustomersTab(raw.customers, { today, aliases });
      if (await snapshotOk("customers", parsed)) {
        const plan = planCustomers({ rows: parsed.rows, index, links, facts, prevRows: prevMirror, deletedPatients, importedAtIso: new Date(started).toISOString() });
        // Planning (identity resolution over every Customers row) can itself take
        // a while — refresh the lease again before writing anything.
        await store.heartbeat(lease);
        const review = [...parsed.issues, ...plan.review];
        const out: TabOutcome = { status: "succeeded", rows_read: parsed.rowsRead, last_date: parsed.lastDate, undated: parsed.undated,
          planned: plan.counts, review: countKinds(review) };
        if (!opts.dryRun) {
          const created: Record<string, string> = {};
          const skippedCreateKeys = new Set<string>();
          const stalePatientIds = new Set<string>();
          const applied: Record<string, number> = {};
          let touchedLinks = false;
          // Review fix C: any create op → a new `sentCreates` flag. Distinct
          // from `Object.keys(created).length` (the old condition): that only
          // knows what the RESPONSE said, so a chunk that committed the
          // create server-side but whose response never reached us (a
          // network error AFTER commit) would leave `created` empty and the
          // patient index unrefreshed. Set from the BATCH CONTENTS, before
          // the call, so a commit-then-throw still triggers the reload below.
          let sentCreates = false;
          // Reload BEFORE staging/committing the mirror: a `hold` op stops a doubted
          // auto link from speaking for that name right away (customer-plan.ts's hold
          // ops; encounter-identity.ts treats decision "review" as a block), and a
          // `link`/`create` op needs the lab/consult tabs to see it too. Reloading here
          // — not after stage/commit — means a later stage/commit failure still leaves
          // lab/consult resolving identity against the FRESH state, not the stale one.
          const reloadIdentity = async () => {
            if (touchedLinks) for (const l of await store.loadLinks()) links.set(l.link_key, l);
            if (sentCreates) index = buildPatientIndex(await store.loadPatients());
          };
          try {
            for (const batch of chunks<CustomerOp>(plan.ops, OPS_CHUNK)) {
              if (batch.some((op) => op.op !== "fill" && op.op !== "facts")) touchedLinks = true;
              if (batch.some((op) => op.op === "create")) sentCreates = true;
              const res = await store.applyCustomerOps(lease, batch);
              Object.assign(created, res.created);
              for (const k of res.skippedCreateKeys) skippedCreateKeys.add(k);
              for (const id of res.stalePatientIds) stalePatientIds.add(id);
              for (const [k, v] of Object.entries(res.counts)) applied[k] = (applied[k] ?? 0) + v;
            }
            await reloadIdentity();
          } catch (opsErr) {
            if (opsErr instanceof LeaseLostError) throw opsErr;
            // A prior chunk in this same loop may have already committed a
            // hold/create/link/fill before this one failed — reloadIdentity()
            // no-ops unless touchedLinks/sentCreates say otherwise, so this is
            // safe to call unconditionally. If the reload itself fails,
            // lab/consult must not run against whatever links/index happened
            // to be loaded before this run started.
            try {
              await reloadIdentity();
            } catch (reloadErr) {
              if (reloadErr instanceof LeaseLostError) throw reloadErr;
              identityStale = true;
            }
            throw opsErr;
          }

          // Every pending_create_key must come from a create op this run just
          // applied, or one it explicitly skipped as a duplicate (review fix
          // B: `skippedCreateKeys` — a create the SQL skipped, live or
          // deleted match, never returns an id; that mirror row stages
          // unresolved instead of failing the whole tab). A key that is
          // neither created nor skipped means the store's response silently
          // dropped it — writing patient_id: null there would stage a mirror
          // row pointing at nobody with no explanation, so fail the tab
          // loudly instead. The message carries a count only: a link key
          // holds a patient's name and DOB.
          // Review fix D: a mirror row whose patient_id the ops loop rejected
          // as `stale` (its facts/fill/link op lost the race to a change
          // made after the planner read the patient) is ALSO unresolved —
          // the reporting mirror must never publish an association the
          // database just rejected.
          let missingIds = 0;
          const mirror = plan.mirror.map(({ pending_create_key, ...row }: CustomerMirrorRow) => {
            if (pending_create_key) {
              const patientId = created[pending_create_key];
              if (patientId) return { ...row, patient_id: patientId };
              if (skippedCreateKeys.has(pending_create_key)) return { ...row, patient_id: null, link_state: "unlinked" };
              missingIds++;
              return { ...row, patient_id: null };
            }
            if (row.patient_id && stalePatientIds.has(row.patient_id)) {
              return { ...row, patient_id: null, link_state: "unlinked" };
            }
            return { ...row, patient_id: row.patient_id };
          });
          if (missingIds) {
            throw new Error(`sheet sync: no created patient id for ${missingIds} mirror row(s) — the store response is missing created ids`);
          }
          for (const batch of chunks(mirror, STAGE_CHUNK)) await store.stage(lease, "customers", batch as unknown as Json[]);
          out.mirror_rows = await store.commit(lease, "customers", mirror.length);
          await store.upsertReview(lease, "customers", review, true);
          out.applied = applied;
        }
        perTab.customers = out;
      }
    } catch (e) {
      if (e instanceof LeaseLostError) throw e;
      perTab.customers = { status: "failed", error: errText(e) };
    }
    await store.heartbeat(lease);

    // Lab + consult (reporting mirror only)
    for (const tab of ["lab", "consult"] as const) {
      try {
        if (identityStale) {
          perTab[tab] = { status: "failed", error: IDENTITY_STALE_MESSAGE };
          continue;
        }
        const parse = tab === "lab" ? parseLabTab : parseConsultTab;
        const parsed = parse(raw[tab], { today, windowStart: settings.mirrorWindowStart });
        if (!(await snapshotOk(tab, parsed))) continue;
        const lines = assignIdentities(parsed.rows, index, links);
        const out: TabOutcome = { status: "succeeded", rows_read: parsed.rowsRead, last_date: parsed.lastDate, undated: parsed.undated,
          planned: { mirror_rows: lines.length, linked: lines.filter((l) => l.patientId).length }, review: countKinds(parsed.issues) };
        if (!opts.dryRun) {
          for (const batch of chunks(lines.map(lineToRow), STAGE_CHUNK)) await store.stage(lease, tab, batch);
          out.mirror_rows = await store.commit(lease, tab, lines.length);
          await store.upsertReview(lease, tab, parsed.issues, true);
        }
        perTab[tab] = out;
      } catch (e) {
        if (e instanceof LeaseLostError) throw e;
        perTab[tab] = { status: "failed", error: errText(e) };
      }
      await store.heartbeat(lease);
    }

    const statuses = (["customers", "lab", "consult"] as const).map((t) => perTab[t]?.status ?? "failed");
    status = statuses.every((s) => s === "succeeded") ? "succeeded"
      : statuses.some((s) => s === "succeeded") ? "partial" : "failed";
  } catch (e) {
    const durationMs = now() - started;
    if (!(e instanceof LeaseLostError)) {
      await store.finish(lease, "failed", perTab as Json, { duration_ms: durationMs } as Json, errText(e)).catch(() => undefined);
    }
    await audit("sheet_sync.failed", acq.runId, { trigger: opts.trigger, error: e instanceof LeaseLostError ? "lease_lost" : "run_error" });
    return { runId: acq.runId, status: "failed", perTab, durationMs, error: errText(e) };
  }

  // The tab work is done — perTab/status already reflect it. Record the run as
  // finished in a SEPARATE try: a failure here (e.g. a network blip writing the
  // final row) must not be mistaken for the tabs having failed, since the
  // customers/lab/consult writes already committed. Never call finish again on
  // this failure — the lease is simply left running and gets reclaimed as dead
  // once its heartbeat goes stale (_sheet_sync_fence, migration 0170).
  const durationMs = now() - started;
  try {
    await store.finish(lease, status, perTab as Json, { duration_ms: durationMs, dry_run: opts.dryRun } as Json, null);
  } catch (e) {
    if (e instanceof LeaseLostError) {
      await audit("sheet_sync.failed", acq.runId, { trigger: opts.trigger, error: "lease_lost" });
      return { runId: acq.runId, status: "failed", perTab, durationMs, error: errText(e) };
    }
    await audit("sheet_sync.finish_failed", acq.runId, { trigger: opts.trigger, status, duration_ms: durationMs, error: errText(e) }).catch(() => undefined);
    throw new Error(`sheet sync: tabs finished (${status}) but the run could not be recorded as finished — ${errText(e)}`);
  }
  await audit(opts.dryRun ? "sheet_sync.dry_run" : status === "succeeded" ? "sheet_sync.completed" : `sheet_sync.${status}`,
    acq.runId, { trigger: opts.trigger, dry_run: opts.dryRun, status, duration_ms: durationMs, per_tab: summarize(perTab) });
  return { runId: acq.runId, status, perTab, durationMs };
}

/** Numbers only for audit metadata (never names). */
function summarize(perTab: Partial<Record<TabKey, TabOutcome>>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(perTab)) {
    out[k] = { status: v?.status, rows_read: v?.rows_read, mirror_rows: v?.mirror_rows, applied: v?.applied, review: v?.review };
  }
  return out;
}

/** Re-sort / alias / revert: one fenced run row per admin action (plan D3). Never subject to pause. */
export async function withAdminLease<T>(
  store: SheetSyncStore,
  trigger: "resort" | "alias" | "revert" | "release",
  actorId: string,
  fn: (lease: string) => Promise<T>,
): Promise<{ runId: string; result: T }> {
  const acq = await store.acquire(trigger, actorId, false);
  if (acq.status !== "running") throw new Error("Admin sheet-sync actions are never paused"); // defensive
  let result: T;
  try {
    result = await fn(acq.leaseToken);
  } catch (e) {
    if (!(e instanceof LeaseLostError)) {
      await store.finish(acq.leaseToken, "failed", {} as Json, {} as Json, errText(e)).catch(() => undefined);
    }
    throw e;
  }
  // The action itself succeeded — record it as finished in a SEPARATE try: a
  // failure here must not report the action as failed (it already ran), and
  // must not call finish again. The lease is left running and gets reclaimed
  // as dead once its heartbeat goes stale (_sheet_sync_fence, migration 0170).
  try {
    await store.finish(acq.leaseToken, "succeeded", {} as Json, { result } as unknown as Json, null);
  } catch (e) {
    if (e instanceof LeaseLostError) throw e;
    throw new Error(`sheet sync: admin action "${trigger}" succeeded but could not be recorded as finished — ${errText(e)}`);
  }
  return { runId: acq.runId, result };
}

export type RevertSummary = Omit<RevertPageResult, "done">;

const REVERT_SUMMARY_KEYS: ReadonlyArray<keyof RevertSummary> =
  ["restored", "blocked", "deleted", "kept", "held", "links_left", "alias_removed", "alias_restored", "gone"];

/** Generous backstop against a stuck loop — a real undo finishes in a handful of pages. */
const REVERT_MAX_PAGES = 1000;

/**
 * Undo a sync run's patient writes, one bounded page at a time under ONE admin
 * lease — 0170's `sheet_sync_revert_run` is resumable across calls that share
 * a lease (migration round 5: p_limit caps patients handled per call so an
 * undo of thousands of patients fits PostgREST's 8s statement_timeout). Only
 * the page that finds nothing left (`done: true`) holds the run's own links,
 * restores/removes its alias and marks the run reverted; every page's counts
 * are per-call, so they are summed here into one total (Task 14's server
 * action uses `.result`).
 */
export async function revertRunPaged(
  store: SheetSyncStore,
  actorId: string,
  targetRunId: string,
  opts: { pageSize?: number } = {},
): Promise<{ runId: string; result: RevertSummary }> {
  const pageSize = opts.pageSize ?? 2000;
  return withAdminLease(store, "revert", actorId, async (lease) => {
    const summary: RevertSummary = { restored: 0, blocked: 0, deleted: 0, kept: 0, held: 0, links_left: 0, alias_removed: 0, alias_restored: 0, gone: 0 };
    for (let page = 0; page < REVERT_MAX_PAGES; page++) {
      const res = await store.revertRun(lease, targetRunId, pageSize);
      for (const k of REVERT_SUMMARY_KEYS) summary[k] += res[k];
      if (res.done) return summary;
      // Every page short of the last one must restore/block/keep/hold at least
      // one patient — otherwise nothing is moving the run toward `done` and the
      // loop would spin forever. Surface that as a clear error instead.
      if (REVERT_SUMMARY_KEYS.every((k) => res[k] === 0)) {
        throw new Error(`sheet sync: revert of run ${targetRunId} made no progress and did not finish — stopping instead of looping forever`);
      }
      await store.heartbeat(lease);
    }
    throw new Error(`sheet sync: revert of run ${targetRunId} did not finish within ${REVERT_MAX_PAGES} pages`);
  });
}

export type ReleaseSummary = Omit<ReleasePageResult, "done">;

/**
 * "Let the sync decide again" for one undo run: releases the holds that undo
 * placed (and every undo run that worked on the same run), one bounded page
 * at a time under ONE admin lease (trigger "release") — 0170's
 * `sheet_sync_release_undo`, paged like the undo so thousands of holds fit
 * the 8 s statement_timeout. Counts are per call and summed here. The next
 * sync then links or creates those rows again. Not undoable.
 */
export async function releaseUndoPaged(
  store: SheetSyncStore,
  actorId: string,
  undoRunId: string,
  opts: { pageSize?: number } = {},
): Promise<{ runId: string; result: ReleaseSummary }> {
  const pageSize = opts.pageSize ?? 2000;
  return withAdminLease(store, "release", actorId, async (lease) => {
    const summary: ReleaseSummary = { released: 0, items_resolved: 0 };
    for (let page = 0; page < REVERT_MAX_PAGES; page++) {
      const res = await store.releaseUndo(lease, undoRunId, pageSize);
      summary.released += res.released;
      summary.items_resolved += res.items_resolved;
      if (res.done) return summary;
      // A page short of the last one always releases at least one hold.
      if (res.released === 0) {
        throw new Error(`sheet sync: release of undo ${undoRunId} made no progress and did not finish — stopping instead of looping forever`);
      }
      await store.heartbeat(lease);
    }
    throw new Error(`sheet sync: release of undo ${undoRunId} did not finish within ${REVERT_MAX_PAGES} pages`);
  });
}

export { LeaseLostError, SyncBusyError };
