import { describe, expect, it, vi } from "vitest";
import { CONS_H0, CONS_H1, CUST_HEADER, LAB_H0, LAB_H1 } from "./__fixtures__/tab-headers";
import { FakeStore } from "./fake-store";
import { runSheetSync } from "./run";
import { SyncBusyError } from "./store";
import type { Cell, RawTabs } from "./types";

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
    expect(result.perTab.customers?.applied?.create).toBe(1);
    expect(store.stagedRows.customers).toHaveLength(1);
    const staged = store.stagedRows.customers[0] as Record<string, unknown>;
    expect(staged).not.toHaveProperty("pending_create_key");
    expect(staged.patient_id).toMatch(/^new-/);
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
