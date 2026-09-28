import { describe, expect, it } from "vitest";
import { QUEUE_KIND, bulkQueueMessage, queueRowKinds, type QueueRowInfo } from "./bulk-queue";

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

  it("caps the named list at five and counts the rest", () => {
    const skipped = Array.from({ length: 7 }, (_, i) => ({ id: `x${i}`, reason: "Gone." }));
    const msg = bulkQueueMessage("Deleted", 7, { changedIds: [], skipped }, {});
    const lines = msg.split("\n");
    expect(lines[1]).toBe("Not changed (7):");
    expect(lines.filter((l) => l.startsWith("• A test"))).toHaveLength(5);
    expect(lines.at(-1)).toBe("• …and 2 more");
  });
});
