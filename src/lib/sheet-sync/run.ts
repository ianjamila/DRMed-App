import { todayManilaISODate } from "../dates/manila";
import type { Json } from "../../types/database";
import { planCustomers } from "./customer-plan";
import { assignIdentities, type IdentifiedLine } from "./encounter-identity";
import { buildPatientIndex, type PatientIndex } from "./patient-index";
import { checkSnapshot } from "./snapshot";
import { LeaseLostError, SyncBusyError, type SheetSyncStore } from "./store";
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
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
  const actorType = opts.trigger === "cron" ? "system" : "staff";
  const audit = (action: string, runId: string | null, metadata: Record<string, unknown>) =>
    store.audit({ actor_id: opts.actorId, actor_type: actorType, action, resource_type: "sheet_sync_run", resource_id: runId, metadata: metadata as Json });

  const acq = await store.acquire(opts.trigger, opts.actorId, opts.dryRun); // SyncBusyError propagates
  if (acq.status === "skipped_paused") {
    await audit("sheet_sync.skipped", acq.runId, { reason: "paused", trigger: opts.trigger });
    return { runId: acq.runId, status: "skipped_paused", perTab: {}, durationMs: now() - started };
  }
  const lease = acq.leaseToken;
  const perTab: Partial<Record<TabKey, TabOutcome>> = {};

  try {
    const [raw, settings, lastGood, patients, linkRows, factRows, aliases, prevMirror] = await Promise.all([
      opts.readSheet(), store.readSettings(), store.lastGoodRowsRead(), store.loadPatients(), store.loadLinks(),
      store.loadFacts(), store.loadAliases(), store.loadCustomerMirror(),
    ]);
    // The initial load (a full patients table, etc.) can itself take a while on
    // a large clinic — refresh the lease before spending more time planning.
    await store.heartbeat(lease);
    let index: PatientIndex = buildPatientIndex(patients);
    const links = new Map<string, LinkRecord>(linkRows.map((l) => [l.link_key, l]));
    const facts = new Map(factRows.map((f) => [f.patient_id, f]));

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
        const plan = planCustomers({ rows: parsed.rows, index, links, facts, prevRows: prevMirror, importedAtIso: new Date(started).toISOString() });
        // Planning (identity resolution over every Customers row) can itself take
        // a while — refresh the lease again before writing anything.
        await store.heartbeat(lease);
        const review = [...parsed.issues, ...plan.review];
        const out: TabOutcome = { status: "succeeded", rows_read: parsed.rowsRead, last_date: parsed.lastDate, undated: parsed.undated,
          planned: plan.counts, review: countKinds(review) };
        if (!opts.dryRun) {
          const created: Record<string, string> = {};
          const applied: Record<string, number> = {};
          for (const batch of chunks<CustomerOp>(plan.ops, OPS_CHUNK)) {
            const res = await store.applyCustomerOps(lease, batch);
            Object.assign(created, res.created);
            for (const [k, v] of Object.entries(res.counts)) applied[k] = (applied[k] ?? 0) + v;
          }
          const mirror = plan.mirror.map(({ pending_create_key, ...row }: CustomerMirrorRow) =>
            ({ ...row, patient_id: pending_create_key ? created[pending_create_key] ?? null : row.patient_id }));
          for (const batch of chunks(mirror, STAGE_CHUNK)) await store.stage(lease, "customers", batch as unknown as Json[]);
          out.mirror_rows = await store.commit(lease, "customers", mirror.length);
          await store.upsertReview(lease, "customers", review, true);
          out.applied = applied;
          if (Object.keys(created).length) {
            // Clinical identity must see the patients this run just created.
            index = buildPatientIndex(await store.loadPatients());
            for (const l of await store.loadLinks()) links.set(l.link_key, l);
          }
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
    const status: RunOutcome["status"] = statuses.every((s) => s === "succeeded") ? "succeeded"
      : statuses.some((s) => s === "succeeded") ? "partial" : "failed";
    const durationMs = now() - started;
    await store.finish(lease, status, perTab as Json, { duration_ms: durationMs, dry_run: opts.dryRun } as Json, null);
    await audit(opts.dryRun ? "sheet_sync.dry_run" : status === "succeeded" ? "sheet_sync.completed" : `sheet_sync.${status}`,
      acq.runId, { trigger: opts.trigger, dry_run: opts.dryRun, status, duration_ms: durationMs, per_tab: summarize(perTab) });
    return { runId: acq.runId, status, perTab, durationMs };
  } catch (e) {
    const durationMs = now() - started;
    if (!(e instanceof LeaseLostError)) {
      await store.finish(lease, "failed", perTab as Json, { duration_ms: durationMs } as Json, errText(e)).catch(() => undefined);
    }
    await audit("sheet_sync.failed", acq.runId, { trigger: opts.trigger, error: e instanceof LeaseLostError ? "lease_lost" : "run_error" });
    return { runId: acq.runId, status: "failed", perTab, durationMs, error: errText(e) };
  }
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
  trigger: "resort" | "alias" | "revert",
  actorId: string,
  fn: (lease: string) => Promise<T>,
): Promise<{ runId: string; result: T }> {
  const acq = await store.acquire(trigger, actorId, false);
  if (acq.status !== "running") throw new Error("Admin sheet-sync actions are never paused"); // defensive
  try {
    const result = await fn(acq.leaseToken);
    await store.finish(acq.leaseToken, "succeeded", {} as Json, { result } as unknown as Json, null);
    return { runId: acq.runId, result };
  } catch (e) {
    if (!(e instanceof LeaseLostError)) {
      await store.finish(acq.leaseToken, "failed", {} as Json, {} as Json, errText(e)).catch(() => undefined);
    }
    throw e;
  }
}

export { LeaseLostError, SyncBusyError };
