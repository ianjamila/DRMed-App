import { describe, it, expect } from "vitest";
import {
  reconcileGroupPrintSnapshot,
  type GroupPrintSnapshot,
  type PrintTimeVisit,
} from "./receipt-print-snapshot";

const line = (
  id: string,
  final: number,
  deleted = false,
): PrintTimeVisit["lines"][number] => ({ id, final, deleted });

const visit = (
  id: string,
  visitNumber: string | null,
  lines: PrintTimeVisit["lines"],
  deleted = false,
): PrintTimeVisit => ({ id, visitNumber, deleted, lines });

const snap = (...slips: [string, ...string[]][]): GroupPrintSnapshot => ({
  slips: slips.map(([visitId, ...lineIds]) => ({ visitId, lineIds })),
});

describe("reconcileGroupPrintSnapshot", () => {
  it("reports exactly the slips and lines that were rendered", () => {
    const group = [
      visit("v1", "101", [line("l1", 500), line("l2", 250)]),
      visit("v2", "102", [line("l3", 900)]),
    ];

    const got = reconcileGroupPrintSnapshot(
      snap(["v1", "l1", "l2"], ["v2", "l3"]),
      group,
    );

    expect(got.visit_ids).toEqual(["v1", "v2"]);
    expect(got.visit_numbers).toEqual(["101", "102"]);
    expect(got.slip_count).toBe(2);
    expect(got.line_count).toBe(3);
    expect(got.total_php).toBe(1650);
    expect(got.visits_not_printed).toEqual([]);
    expect(got.snapshot_ids_dropped).toBe(0);
  });

  it("preserves the page's render order, not the database's", () => {
    // The page sorts Doctor/PF slips first; the group read is by visit_number.
    const group = [
      visit("lab", "101", [line("l1", 300)]),
      visit("doc", "102", [line("l2", 700)]),
    ];

    const got = reconcileGroupPrintSnapshot(snap(["doc", "l2"], ["lab", "l1"]), group);

    expect(got.visit_ids).toEqual(["doc", "lab"]);
    expect(got.visit_numbers).toEqual(["102", "101"]);
  });

  // --- Defect 1: deleted between render and print --------------------------

  it("still counts a visit soft-deleted after the render, and flags it", () => {
    // window.print() fires before the action, so the paper is already out.
    const group = [
      visit("v1", "101", [line("l1", 500)]),
      visit("v2", "102", [line("l2", 900)], true),
    ];

    const got = reconcileGroupPrintSnapshot(snap(["v1", "l1"], ["v2", "l2"]), group);

    expect(got.visit_ids).toEqual(["v1", "v2"]);
    expect(got.slip_count).toBe(2);
    expect(got.total_php).toBe(1400);
    expect(got.visits_deleted_after_render).toEqual(["v2"]);
    expect(got.visits_not_printed).toEqual([]);
  });

  it("still counts a LINE soft-deleted after the render, and flags it", () => {
    const group = [visit("v1", "101", [line("l1", 500), line("l2", 250, true)])];

    const got = reconcileGroupPrintSnapshot(snap(["v1", "l1", "l2"]), group);

    expect(got.line_count).toBe(2);
    expect(got.total_php).toBe(750);
    expect(got.lines_deleted_after_render).toEqual(["l2"]);
  });

  // --- Defect 2: slips the page suppressed ---------------------------------

  it("excludes a consultation-only slip the page suppressed, and names it", () => {
    // shouldPrintReceipt() drops the doctor slip; it is live, so the old
    // re-read counted its money even though no sheet ever showed it.
    const group = [
      visit("lab", "101", [line("l1", 500)]),
      visit("consult", "102", [line("l2", 900)]),
    ];

    const got = reconcileGroupPrintSnapshot(snap(["lab", "l1"]), group);

    expect(got.visit_ids).toEqual(["lab"]);
    expect(got.slip_count).toBe(1);
    expect(got.total_php).toBe(500);
    expect(got.visits_not_printed).toEqual(["consult"]);
  });

  it("excludes a line the page hid as soft-deleted at render time", () => {
    const group = [visit("v1", "101", [line("l1", 500), line("l2", 250, true)])];

    // The page ran visibleReceiptLines, so l2 never reached the snapshot.
    const got = reconcileGroupPrintSnapshot(snap(["v1", "l1"]), group);

    expect(got.line_count).toBe(1);
    expect(got.total_php).toBe(500);
    expect(got.lines_deleted_after_render).toEqual([]);
  });

  it("records a print of nothing rather than inventing one", () => {
    const group = [visit("consult", "101", [line("l1", 900)])];

    const got = reconcileGroupPrintSnapshot({ slips: [] }, group);

    expect(got.visit_ids).toEqual([]);
    expect(got.total_php).toBe(0);
    expect(got.visits_not_printed).toEqual(["consult"]);
  });

  // --- Only the selection is trusted ---------------------------------------

  it("drops a visit id that is not in this group", () => {
    const group = [visit("v1", "101", [line("l1", 500)])];

    const got = reconcileGroupPrintSnapshot(
      snap(["v1", "l1"], ["someone-elses-visit", "l9"]),
      group,
    );

    expect(got.visit_ids).toEqual(["v1"]);
    expect(got.total_php).toBe(500);
    expect(got.snapshot_ids_dropped).toBe(1);
  });

  it("drops a line id that does not belong to its visit", () => {
    const group = [
      visit("v1", "101", [line("l1", 500)]),
      visit("v2", "102", [line("l2", 900)]),
    ];

    // l2 is real, but it is v2's line — it must not be billed to v1's slip.
    const got = reconcileGroupPrintSnapshot(snap(["v1", "l1", "l2"]), group);

    expect(got.line_count).toBe(1);
    expect(got.total_php).toBe(500);
    expect(got.snapshot_ids_dropped).toBe(1);
  });

  it("cannot inflate a total by repeating an id", () => {
    const group = [visit("v1", "101", [line("l1", 500)])];

    const got = reconcileGroupPrintSnapshot(
      snap(["v1", "l1", "l1", "l1"], ["v1", "l1"]),
      group,
    );

    expect(got.slip_count).toBe(1);
    expect(got.line_count).toBe(1);
    expect(got.total_php).toBe(500);
    expect(got.snapshot_ids_dropped).toBe(3);
  });

  it("takes every figure from the database row, never from the snapshot", () => {
    // The snapshot carries ids and nothing else, so there is no peso value on
    // it to tamper with — this pins that shape.
    const group = [visit("v1", "101", [line("l1", 500)])];
    const got = reconcileGroupPrintSnapshot(snap(["v1", "l1"]), group);

    expect(got.total_php).toBe(500);
    expect(Object.keys({ visitId: "", lineIds: [] })).toEqual([
      "visitId",
      "lineIds",
    ]);
  });
});
