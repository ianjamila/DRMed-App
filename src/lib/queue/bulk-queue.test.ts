import { describe, expect, it } from "vitest";
import {
  QUEUE_KIND,
  bulkQueueMessage,
  panelKey,
  parsePanelKey,
  queueRowKinds,
  splitQueueKeys,
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
const T = "33333333-3333-4333-8333-333333333333";

describe("panel keys", () => {
  it("round-trips", () => {
    expect(parsePanelKey(panelKey(V, G))).toEqual({ visitId: V, groupId: G });
  });
  it("rejects anything that is not two uuids", () => {
    expect(parsePanelKey(T)).toBeNull();
    expect(parsePanelKey(`panel:${V}`)).toBeNull();
    expect(parsePanelKey(`panel:${V}:nope`)).toBeNull();
    expect(parsePanelKey(`panel:${V}:${G}:x`)).toBeNull();
  });
  it("splits a selection into single tests and panels", () => {
    expect(splitQueueKeys([T, panelKey(V, G)])).toEqual({
      testIds: [T],
      panels: [{ key: panelKey(V, G), visitId: V, groupId: G }],
    });
  });
});
