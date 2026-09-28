import { describe, expect, it } from "vitest";
import {
  QUEUE_KIND,
  bulkQueueMessage,
  combineClaimResults,
  panelRowKey,
  parsePanelRowKey,
  queueRowKinds,
  sentTestCount,
  type QueueRowInfo,
} from "./bulk-queue";

const rows: Record<string, QueueRowInfo> = {
  a: { visitId: "v1", label: "CBC — Santos, Maria", assignedTo: null },
  b: { visitId: "v1", label: "Urinalysis — Santos, Maria", assignedTo: null },
  c: { visitId: "v2", label: "Chest X-ray — Cruz, Ana", assignedTo: null },
};

describe("queueRowKinds", () => {
  it("lists only the true flags, in bar order", () => {
    expect(queueRowKinds({ claimable: true, unclaimable: false, deletable: true })).toEqual([
      QUEUE_KIND.claim,
      QUEUE_KIND.delete,
    ]);
    expect(queueRowKinds({ claimable: false, unclaimable: false, deletable: false })).toEqual([]);
  });
});

describe("bulkQueueMessage", () => {
  it("says the plain count when everything changed", () => {
    expect(bulkQueueMessage("Claimed", 2, { changedIds: ["a", "b"], skipped: [] }, rows)).toBe(
      "Claimed 2 tests.",
    );
    expect(bulkQueueMessage("Claimed", 1, { changedIds: ["a"], skipped: [] }, rows)).toBe(
      "Claimed 1 test.",
    );
  });

  it("names every skipped row with its reason", () => {
    expect(
      bulkQueueMessage(
        "Claimed",
        3,
        {
          changedIds: ["a"],
          skipped: [
            { id: "b", reason: "Claimed by someone else or changed just now." },
            { id: "c", reason: "Only an X-ray technician can claim this test." },
          ],
        },
        rows,
      ),
    ).toBe(
      [
        "Claimed 1 of 3 tests.",
        "Not changed (2):",
        "• Urinalysis — Santos, Maria: Claimed by someone else or changed just now.",
        "• Chest X-ray — Cruz, Ana: Only an X-ray technician can claim this test.",
      ].join("\n"),
    );
  });

  it("says nothing changed when nothing did", () => {
    expect(
      bulkQueueMessage("Unclaimed", 1, { changedIds: [], skipped: [{ id: "a", reason: "Gone." }] }, rows),
    ).toBe(["Nothing unclaimed.", "Not changed (1):", "• CBC — Santos, Maria: Gone."].join("\n"));
  });

  it("names every skipped row, however many", () => {
    const skipped = Array.from({ length: 7 }, (_, i) => ({ id: `x${i}`, reason: `Gone ${i}.` }));
    const msg = bulkQueueMessage("Deleted", 7, { changedIds: [], skipped }, {});
    const lines = msg.split("\n");
    expect(lines[1]).toBe("Not changed (7):");
    expect(lines.slice(2)).toEqual(skipped.map((s) => `• A test: ${s.reason}`));
  });
});

const V = "11111111-1111-4111-8111-111111111111";
const G = "22222222-2222-4222-8222-222222222222";

describe("panelRowKey / parsePanelRowKey", () => {
  it("round-trips a visit + report group", () => {
    expect(parsePanelRowKey(panelRowKey(V, G))).toEqual({ visitId: V, groupId: G });
  });

  it("reads a single test id (or anything malformed) as not a panel", () => {
    expect(parsePanelRowKey(V)).toBeNull();
    expect(parsePanelRowKey("panel:")).toBeNull();
    expect(parsePanelRowKey(`panel:${V}`)).toBeNull();
    expect(parsePanelRowKey(`panel:${V}:${G}:extra`)).toBeNull();
  });
});

describe("combineClaimResults", () => {
  const panelKey = panelRowKey(V, G);

  it("returns a refused single-test call as-is", () => {
    const refused = { ok: false as const, error: "Only lab staff can claim or unclaim tests from the queue." };
    expect(combineClaimResults(refused, null, [panelKey])).toBe(refused);
  });

  it("joins claimed tests and skipped rows from both calls", () => {
    expect(
      combineClaimResults(
        { ok: true, changedIds: ["a"], skipped: [{ id: "b", reason: "taken" }] },
        { ok: true, changedIds: ["m1", "m2"], skipped: [] },
        [panelKey],
      ),
    ).toEqual({ ok: true, changedIds: ["a", "m1", "m2"], skipped: [{ id: "b", reason: "taken" }] });
  });

  it("keeps the single tests claimed when the whole panel call is refused", () => {
    expect(
      combineClaimResults(
        { ok: true, changedIds: ["a"], skipped: [] },
        { ok: false, error: "Could not read the selection." },
        [panelKey],
      ),
    ).toEqual({
      ok: true,
      changedIds: ["a"],
      skipped: [{ id: panelKey, reason: "Could not read the selection." }],
    });
  });

  it("works with panels only", () => {
    expect(
      combineClaimResults(null, { ok: true, changedIds: ["m1"], skipped: [] }, [panelKey]),
    ).toEqual({ ok: true, changedIds: ["m1"], skipped: [] });
  });
});

describe("sentTestCount", () => {
  const withPanel: Record<string, QueueRowInfo> = {
    ...rows,
    [panelRowKey(V, G)]: {
      visitId: V,
      label: "Chemistry (10 tests) — Jamila, Ian",
      assignedTo: null,
      testCount: 10,
    },
  };

  it("equals the key count for single tests", () => {
    expect(
      sentTestCount({ changedIds: ["a"], skipped: [{ id: "b", reason: "x" }] }, rows),
    ).toBe(2);
  });

  it("weights a skipped panel by its tests, so the message says 1 of 11", () => {
    const result = {
      changedIds: ["a"],
      skipped: [{ id: panelRowKey(V, G), reason: "Some tests in this report were already claimed or changed status." }],
    };
    expect(sentTestCount(result, withPanel)).toBe(11);
    expect(bulkQueueMessage("Claimed", sentTestCount(result, withPanel), result, withPanel)).toBe(
      "Claimed 1 of 11 tests.\nNot changed (1):\n• Chemistry (10 tests) — Jamila, Ian: Some tests in this report were already claimed or changed status.",
    );
  });
});
