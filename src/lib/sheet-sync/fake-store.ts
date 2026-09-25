/**
 * In-memory `SheetSyncStore` for run.test.ts (Task 11 Step 2) — not imported
 * by app code. `leaseLostAfter` mirrors `_sheet_sync_fence` (0170): EVERY
 * fenced RPC, heartbeat/finish included, can raise P0063 once the lease looks
 * stale, so it counts every fenced call, not only the writes.
 */
import type { Json } from "../../types/database";
import { LeaseLostError, SyncBusyError, type AcquireResult, type AuditRow, type SheetSyncStore } from "./store";
import type { CustomerOp, FactsRecord, LinkRecord, PatientRecord, PrevCustomerRow, ReviewItemInput, TabKey } from "./types";

let runCounter = 0;

export interface FakeStoreOptions {
  paused?: boolean;
  busy?: boolean;
  /** Throw LeaseLostError on the Nth fenced call (1-based). */
  leaseLostAfter?: number;
  patients?: PatientRecord[];
  links?: LinkRecord[];
  facts?: FactsRecord[];
  aliases?: Map<string, string>;
  mirror?: PrevCustomerRow[];
  lastGood?: Partial<Record<TabKey, number>>;
  acceptedSuspect?: Iterable<string>;
  mirrorWindowStart?: string;
}

export class FakeStore implements SheetSyncStore {
  calls: Array<[string, ...unknown[]]> = [];
  audits: AuditRow[] = [];
  stagedRows: Record<TabKey, unknown[]> = { customers: [], lab: [], consult: [] };
  finishes: Array<{ status: string; error: string | null }> = [];

  private paused: boolean;
  private busy: boolean;
  private leaseLostAfter: number | null;
  private fenceCount = 0;
  private patients: PatientRecord[];
  private links: Map<string, LinkRecord>;
  private facts: Map<string, FactsRecord>;
  private aliases: Map<string, string>;
  private mirror: PrevCustomerRow[];
  private lastGood: Partial<Record<TabKey, number>>;
  private acceptedSuspect: Set<string>;
  private mirrorWindowStart: string;

  constructor(opts: FakeStoreOptions = {}) {
    this.paused = opts.paused ?? false;
    this.busy = opts.busy ?? false;
    this.leaseLostAfter = opts.leaseLostAfter ?? null;
    this.patients = opts.patients ?? [];
    this.links = new Map((opts.links ?? []).map((l) => [l.link_key, l]));
    this.facts = new Map((opts.facts ?? []).map((f) => [f.patient_id, f]));
    this.aliases = opts.aliases ?? new Map();
    this.mirror = opts.mirror ?? [];
    this.lastGood = opts.lastGood ?? {};
    this.acceptedSuspect = new Set(opts.acceptedSuspect ?? []);
    this.mirrorWindowStart = opts.mirrorWindowStart ?? "2024-01-01";
  }

  private fence(): void {
    this.fenceCount++;
    if (this.leaseLostAfter !== null && this.fenceCount >= this.leaseLostAfter) throw new LeaseLostError();
  }

  async acquire(trigger: Parameters<SheetSyncStore["acquire"]>[0], _actorId: string | null, dryRun: boolean): Promise<AcquireResult> {
    this.calls.push(["acquire", trigger, dryRun]);
    if (this.busy) throw new SyncBusyError();
    const runId = `run-${++runCounter}`;
    if (this.paused && trigger !== "resort" && trigger !== "alias" && trigger !== "revert" && !dryRun) return { status: "skipped_paused", runId };
    return { status: "running", runId, leaseToken: `lease-${runId}` };
  }

  async heartbeat(lease: string) { this.calls.push(["heartbeat", lease]); this.fence(); }

  async finish(_lease: string, status: "succeeded" | "partial" | "failed", _perTab: Json, _summary: Json, error: string | null) {
    this.calls.push(["finish", status]);
    this.fence();
    this.finishes.push({ status, error });
  }

  async readSettings() { return { paused: this.paused, mirrorWindowStart: this.mirrorWindowStart }; }
  async lastGoodRowsRead() { return this.lastGood; }
  async isSuspectAccepted(tab: TabKey, rowsRead: number) { return this.acceptedSuspect.has(`${tab}:${rowsRead}`); }
  async loadPatients() { return this.patients; }
  async loadLinks() { return [...this.links.values()]; }
  async loadFacts() { return [...this.facts.values()]; }
  async loadAliases() { return new Map(this.aliases); }
  async loadCustomerMirror() { return this.mirror; }
  async resortCandidates() { return []; }

  async applyCustomerOps(_lease: string, ops: CustomerOp[]) {
    this.calls.push(["applyCustomerOps", ops.length]);
    this.fence();
    const created: Record<string, string> = {};
    const counts: Record<string, number> = {};
    for (const op of ops) {
      counts[op.op] = (counts[op.op] ?? 0) + 1;
      if (op.op === "create") created[op.create_key] = `new-${op.create_key}`;
    }
    return { created, counts };
  }

  async stage(_lease: string, tab: TabKey, rows: Json[]) {
    this.calls.push(["stage", tab, rows.length]);
    this.fence();
    this.stagedRows[tab].push(...rows);
  }

  async commit(_lease: string, tab: TabKey, expected: number) {
    this.calls.push(["commit", tab, expected]);
    this.fence();
    const staged = this.stagedRows[tab].length;
    if (staged !== expected) throw new Error(`Staged row count mismatch: staged ${staged}, expected ${expected}.`);
    return staged;
  }

  async upsertReview(_lease: string, tab: TabKey, items: ReviewItemInput[], clearAbsent: boolean) {
    this.calls.push(["upsertReview", tab, items.length, clearAbsent]);
    this.fence();
    const counts: Record<string, number> = {};
    for (const i of items) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
    return counts;
  }

  async resortApply(_lease: string, patientIds: string[], expectedOld: string | null, next: string | null) {
    this.calls.push(["resortApply", patientIds.length, expectedOld, next]);
    this.fence();
    return patientIds.length;
  }

  async aliasApply(_lease: string, answerNorm: string, sourceId: string, actorId: string) {
    this.calls.push(["aliasApply", answerNorm, sourceId, actorId]);
    this.fence();
    return 1;
  }

  async revertRun(_lease: string, targetRunId: string) {
    this.calls.push(["revertRun", targetRunId]);
    this.fence();
    return {};
  }

  async reviewResolve(itemId: string, _actorId: string, action: "link" | "create" | "dismiss", patientId: string | null) {
    this.calls.push(["reviewResolve", itemId, action, patientId]);
  }

  async audit(row: AuditRow) {
    this.calls.push(["audit", row.action, row.actor_type]);
    this.audits.push(row);
  }
}
