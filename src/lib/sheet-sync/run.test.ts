import { describe, expect, it, vi } from "vitest";
import { CONS_H0, CONS_H1, CUST_HEADER, LAB_H0, LAB_H1 } from "./__fixtures__/tab-headers";
import { FakeStore } from "./fake-store";
import { runSheetSync, withAdminLease } from "./run";
import { SyncBusyError } from "./store";
import type { Cell, CustomerOp, LinkRecord, PatientRecord, RawTabs, TabKey } from "./types";
import type { Json } from "../../types/database";

const TODAY = "2026-09-24";

/** One valid Customers row: "Dela Cruz, Juan Santos", DOB 1990-01-01, registered 2025-12-09. */
const custRow = (over: Record<number, Cell> = {}): Cell[] => {
  const r: Cell[] = new Array(22).fill("");
  r[4] = "Dela Cruz, Juan Santos"; r[5] = "Male"; r[6] = 32874; r[11] = 9171234567;
  r[16] = "FACEBOOK"; r[19] = "NEW"; r[20] = 46000.5;
  for (const [k, v] of Object.entries(over)) r[Number(k)] = v;
  return r;
};

/** One valid LAB SERVICE row, service date serial 46168 = 2026-05-26 (inside the default window). */
const labRow = (n: number): Cell[] =>
  [46168, `C${n}`, `T${n}`, "Dela Cruz, Juan", "N/A", "", "", "CBC", 350, "", "", "", "", 300, "CASH", "", "Viber", 46169];

const customersTab = (rows: Cell[][] = [custRow()]): Cell[][] => [CUST_HEADER, ...rows];
const labTab = (n: number): Cell[][] => [LAB_H0, LAB_H1, ...Array.from({ length: n }, (_, i) => labRow(i))];
const emptyConsultTab: Cell[][] = [CONS_H0, CONS_H1];

const tabs = (over: Partial<RawTabs> = {}): RawTabs =>
  ({ customers: customersTab(), lab: labTab(1), consult: emptyConsultTab, ...over });

const run = (store: FakeStore, opts: Partial<Parameters<typeof runSheetSync>[0]> = {}, readSheet = async () => tabs()) =>
  runSheetSync({ store, readSheet, trigger: "manual", actorId: "staff-1", dryRun: false, today: TODAY, ...opts });

describe("runSheetSync", () => {
  it("paused: records skipped_paused, audits sheet_sync.skipped as system for cron, reads nothing", async () => {
    const store = new FakeStore({ paused: true });
    const readSheet = vi.fn(async () => tabs());
    const result = await runSheetSync({ store, readSheet, trigger: "cron", actorId: null, dryRun: false, today: TODAY });
    expect(result.status).toBe("skipped_paused");
    expect(readSheet).not.toHaveBeenCalled();
    const skipped = store.audits.find((a) => a.action === "sheet_sync.skipped");
    expect(skipped).toMatchObject({ actor_type: "system" });
  });

  it("dry run: plans every tab, writes NOTHING but finish + audit", async () => {
    const store = new FakeStore({});
    const result = await run(store, { dryRun: true });
    expect(result.status).toBe("succeeded");
    expect(result.perTab.customers?.planned?.create).toBe(1);
    const writeCalls = store.calls.filter((c) => ["applyCustomerOps", "stage", "commit", "upsertReview"].includes(c[0] as string));
    expect(writeCalls).toHaveLength(0);
    expect(store.calls.some((c) => c[0] === "finish")).toBe(true);
    expect(store.calls.some((c) => c[0] === "audit")).toBe(true);
  });

  it("real run: ops → stage (≤2000 per chunk) → commit per tab → review upsert with clearAbsent", async () => {
    const store = new FakeStore({});
    const result = await run(store, {}, async () => tabs({ lab: labTab(4500) }));
    expect(result.status).toBe("succeeded");

    const labStages = store.calls.filter((c) => c[0] === "stage" && c[1] === "lab");
    expect(labStages.map((c) => c[2])).toEqual([2000, 2000, 500]);
    const labCommits = store.calls.filter((c) => c[0] === "commit" && c[1] === "lab");
    expect(labCommits).toEqual([["commit", "lab", 4500]]);
    expect(store.calls.filter((c) => c[0] === "upsertReview" && c[1] === "lab")).toHaveLength(1);

    // Customers: 1 row → 1 create op → the created id replaces pending_create_key in the staged mirror row.
    // "created" is 0170's own count key (sheet_sync_apply_customer_ops), not the op's `op` field.
    expect(result.perTab.customers?.applied?.created).toBe(1);
    expect(store.stagedRows.customers).toHaveLength(1);
    const staged = store.stagedRows.customers[0] as Record<string, unknown>;
    expect(staged).not.toHaveProperty("pending_create_key");
    expect(staged.patient_id).toMatch(/^new:/);
  });

  it("a failing tab makes the run partial, the others still commit, and the audit is sheet_sync.partial", async () => {
    const store = new FakeStore({});
    const brokenConsultHeader = [...CONS_H0];
    brokenConsultHeader.splice(3, 0, "New column"); // shifts PATIENT NAME etc. out of position
    const result = await run(store, {}, async () => tabs({ consult: [brokenConsultHeader, CONS_H1] }));
    expect(result.status).toBe("partial");
    expect(result.perTab.consult?.status).toBe("failed");
    expect(result.perTab.consult?.error).toMatch(/header/i);
    expect(result.perTab.lab?.status).toBe("succeeded");
    expect(store.calls.some((c) => c[0] === "commit" && c[1] === "lab")).toBe(true);
    expect(store.audits.some((a) => a.action === "sheet_sync.partial")).toBe(true);
  });

  it("a >5% shrink skips that tab as suspect and raises suspect_snapshot without clearing other items", async () => {
    const store = new FakeStore({ lastGood: { lab: 100 } });
    const result = await run(store, {}, async () => tabs({ lab: labTab(90) }));
    expect(result.perTab.lab?.status).toBe("failed");
    expect(result.perTab.lab?.error).toMatch(/suspect_snapshot: 100 → 90 rows \(−10%\)/);
    expect(result.status).toBe("partial");
    expect(store.calls.some((c) => c[0] === "stage" && c[1] === "lab")).toBe(false);
    const suspectReview = store.calls.find((c) => c[0] === "upsertReview" && c[1] === "lab");
    expect(suspectReview).toEqual(["upsertReview", "lab", 1, false]);
  });

  it("an accepted suspect count proceeds", async () => {
    const store = new FakeStore({ lastGood: { lab: 100 }, acceptedSuspect: ["lab:90"] });
    const result = await run(store, {}, async () => tabs({ lab: labTab(90) }));
    expect(result.perTab.lab?.status).toBe("succeeded");
    expect(store.calls.some((c) => c[0] === "commit" && c[1] === "lab" && c[2] === 90)).toBe(true);
  });

  it("sheet read failure → failed run with the error, finish still called", async () => {
    const store = new FakeStore({});
    const result = await runSheetSync({
      store, readSheet: async () => { throw new Error("network down"); },
      trigger: "manual", actorId: "staff-1", dryRun: false, today: TODAY,
    });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("network down");
    expect(store.finishes).toEqual([{ status: "failed", error: "network down" }]);
  });

  it("lease lost mid-run stops without calling finish and reports failed", async () => {
    // 1st fenced call = the post-load heartbeat; 2nd = the post-planning heartbeat, which loses the lease.
    const store = new FakeStore({ leaseLostAfter: 2 });
    const result = await run(store);
    expect(result.status).toBe("failed");
    expect(store.calls.some((c) => c[0] === "finish")).toBe(false);
    expect(store.audits.some((a) => a.action === "sheet_sync.failed")).toBe(true);
  });

  it("busy → throws SyncBusyError before reading the sheet", async () => {
    const store = new FakeStore({ busy: true });
    const readSheet = vi.fn(async () => tabs());
    await expect(runSheetSync({ store, readSheet, trigger: "manual", actorId: "staff-1", dryRun: false, today: TODAY }))
      .rejects.toBeInstanceOf(SyncBusyError);
    expect(readSheet).not.toHaveBeenCalled();
  });

  it("audit metadata carries counts and ids only — no names", async () => {
    const store = new FakeStore({});
    await run(store);
    const completed = store.audits.find((a) => a.action === "sheet_sync.completed");
    expect(completed).toBeDefined();
    const json = JSON.stringify(completed!.metadata);
    expect(json).not.toContain("Dela Cruz");
    expect(json).not.toContain("Juan");
  });

  it("manual runs audit as staff with the actor id", async () => {
    const store = new FakeStore({});
    await run(store, { trigger: "manual", actorId: "staff-42" });
    const completed = store.audits.find((a) => a.action === "sheet_sync.completed");
    expect(completed).toMatchObject({ actor_type: "staff", actor_id: "staff-42" });
  });
});

describe("runSheetSync — identity reload after customer ops (review fix #1)", () => {
  it("a hold op applied this run unlinks a lab line for that name, instead of leaving it on the stale (pre-reload) link", async () => {
    // P1 has a DIFFERENT name than the held key on purpose: the stored link is a
    // historical loose/corroboration decision (undated key "dela cruz|juan#" →
    // p1), not a name match. So the only way this run's lab line could resolve
    // to p1 is via that saved decision (encounter-identity step 1) — and this
    // run's Customers processing is about to turn that decision into a hold.
    const p1: PatientRecord = {
      id: "p1", drm_id: "DRM-P1", first_name: "Juanito", middle_name: null, last_name: "Reyes",
      birthdate: null, phone: "9170000000", phone_normalized: null, email: null, sex: null, address: null,
      referred_by_doctor: null, preferred_release_medium: null, senior_pwd_id_kind: null, senior_pwd_id_number: null,
      referral_source: null, referral_source_origin: null, merged_into_id: null,
    };
    const staleLink: LinkRecord = { link_key: "dela cruz|juan#", patient_id: "p1", decision: "link", method: "auto_loose", hold_reason: null };
    const store = new FakeStore({ patients: [p1], links: [staleLink] });

    // No DOB, and a phone that conflicts with p1's — customer-plan.ts flags this
    // as identity_conflict against the stored link and emits a `hold` op for the
    // SAME undated key ("dela cruz|juan#").
    const custHoldRow = custRow({ 4: "Dela Cruz, Juan", 6: "", 11: "9181234567" });
    const result = await run(store, {}, async () => tabs({
      customers: customersTab([custHoldRow]),
      lab: [LAB_H0, LAB_H1, labRow(1)], // nameRaw "Dela Cruz, Juan" — same nameNorm as the held key
    }));

    expect(result.perTab.customers?.planned?.hold).toBe(1);
    expect(store.stagedRows.lab).toHaveLength(1);
    const stagedLab = store.stagedRows.lab[0] as Record<string, unknown>;
    expect(stagedLab.patient_id).toBeNull();
    expect(result.perTab.lab?.planned?.linked).toBe(0);
  });

  it("a multi-key create resolves every key's mirror row to the SAME created id", async () => {
    const store = new FakeStore({});
    const rowA = custRow(); // dated: "Dela Cruz, Juan Santos", DOB 1990-01-01
    const rowB = custRow({ 6: "", 11: "" }); // same name, undated, no phone — joins rowA's create cluster
    const result = await run(store, {}, async () => tabs({ customers: [CUST_HEADER, rowA, rowB] }));

    expect(result.perTab.customers?.status).toBe("succeeded");
    expect(result.perTab.customers?.planned?.create).toBe(1); // ONE create op covers both keys
    expect(store.stagedRows.customers).toHaveLength(2);
    const staged = store.stagedRows.customers as Record<string, unknown>[];
    expect(staged[0].patient_id).toBeTruthy();
    expect(staged[0].patient_id).toBe(staged[1].patient_id);
    for (const row of staged) expect(row).not.toHaveProperty("pending_create_key");
  });

  it("a store response that drops a create op's id fails the customers tab loudly instead of staging a null patient_id (review fix #3)", async () => {
    class DropCreatedIdsStore extends FakeStore {
      async applyCustomerOps(lease: string, ops: CustomerOp[]) {
        const res = await super.applyCustomerOps(lease, ops);
        return { ...res, created: {} }; // simulate a store response that lost the create → id mapping
      }
    }
    const store = new DropCreatedIdsStore({});
    const rowA = custRow();
    const rowB = custRow({ 6: "", 11: "" });
    const result = await run(store, {}, async () => tabs({ customers: [CUST_HEADER, rowA, rowB] }));

    expect(result.perTab.customers?.status).toBe("failed");
    expect(result.perTab.customers?.error).toMatch(/no created patient id/);
    expect(store.stagedRows.customers).toHaveLength(0); // never staged the broken mirror
  });
});

describe("runSheetSync — errText redacts foreign PG error text (review fix #4)", () => {
  it("a SQLSTATE that isn't ours is redacted to 'database error <code>', and the full message is logged server-side only", async () => {
    class BadDateCommitStore extends FakeStore {
      async commit(lease: string, tab: TabKey, expected: number) {
        if (tab === "lab") {
          const e = new Error('invalid input syntax for type date: "not-a-real-date"') as Error & { code?: string };
          e.code = "22P02"; // Postgres's own invalid_text_representation — not one of ours
          throw e;
        }
        return super.commit(lease, tab, expected);
      }
    }
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = new BadDateCommitStore({});
    const result = await run(store);

    expect(result.perTab.lab?.status).toBe("failed");
    expect(result.perTab.lab?.error).toBe("database error 22P02");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "sheet sync: redacted database error",
      expect.objectContaining({ code: "22P02", message: expect.stringContaining("not-a-real-date") }),
    );
    consoleErrorSpy.mockRestore();
  });

  it("our own P00NN / 22023 errors pass through unredacted — they're already hand-authored, no row data", async () => {
    class MismatchCommitStore extends FakeStore {
      async commit(lease: string, tab: TabKey, expected: number) {
        if (tab === "consult") {
          const e = new Error("Staged row count mismatch: staged 0, expected 1.") as Error & { code?: string };
          e.code = "22023";
          throw e;
        }
        return super.commit(lease, tab, expected);
      }
    }
    const store = new MismatchCommitStore({});
    const consultRow: Cell[] = [46168, "", "", "Dela Cruz, Juan", "N/A", "", "", "DR. A", 1000, "", "", 1000, 300, "CASH", "", ""];
    const result = await run(store, {}, async () => tabs({ consult: [CONS_H0, CONS_H1, consultRow] }));

    expect(result.perTab.consult?.status).toBe("failed");
    expect(result.perTab.consult?.error).toBe("Staged row count mismatch: staged 0, expected 1.");
  });
});

describe("runSheetSync — a failed final finish is not mistaken for failed tabs (review fix #5)", () => {
  it("throws (does not report status: failed) when the SUCCESS finish call itself fails, and never calls finish a second time", async () => {
    class FailSuccessFinishStore extends FakeStore {
      async finish(lease: string, status: "succeeded" | "partial" | "failed", perTab: Json, summary: Json, error: string | null) {
        if (status !== "failed") {
          this.calls.push(["finish", status]); // record the attempt the same way the base class would
          throw new Error("write timeout");
        }
        return super.finish(lease, status, perTab, summary, error);
      }
    }
    const store = new FailSuccessFinishStore({});
    await expect(run(store)).rejects.toThrow(/tabs finished \(succeeded\) but the run could not be recorded as finished/);
    // Exactly the one failed attempt — never a second "failed" finish call papering over it.
    expect(store.calls.filter((c) => c[0] === "finish")).toHaveLength(1);
  });
});

describe("withAdminLease — same fix for admin actions (review fix #5)", () => {
  it("does not report a successful admin action as failed when only the finish call fails, and never calls finish twice", async () => {
    class FailSuccessFinishStore extends FakeStore {
      async finish(lease: string, status: "succeeded" | "partial" | "failed", perTab: Json, summary: Json, error: string | null) {
        if (status === "succeeded") {
          this.calls.push(["finish", status]);
          throw new Error("write timeout");
        }
        return super.finish(lease, status, perTab, summary, error);
      }
    }
    const store = new FailSuccessFinishStore({});
    await expect(withAdminLease(store, "resort", "staff-1", async () => "ok"))
      .rejects.toThrow(/admin action "resort" succeeded but could not be recorded as finished/);
    expect(store.calls.filter((c) => c[0] === "finish")).toHaveLength(1);
  });
});
