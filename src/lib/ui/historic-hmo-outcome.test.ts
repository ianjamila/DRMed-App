import { describe, expect, it } from "vitest";
import { historicBulkOutcomeMessage } from "./historic-hmo-outcome";

describe("historicBulkOutcomeMessage", () => {
  it("mark billed: no reversal wording", () => {
    expect(historicBulkOutcomeMessage("billed", 3, 3)).toBe("Marked 3 claims as billed.");
  });

  it("mark paid: says Undo reverses the journal entries", () => {
    expect(historicBulkOutcomeMessage("paid", 2, 2)).toBe(
      "Marked 2 claims as paid. Undo within 10 minutes reverses the journal entries and returns them to the status they had before.",
    );
  });

  it("write off, singular: says Undo reverses the journal entry", () => {
    expect(historicBulkOutcomeMessage("writeoff", 1, 1)).toBe(
      "Wrote off 1 claim. Undo within 10 minutes reverses the journal entry and returns it to the status it had before.",
    );
  });

  it("partial: some requested claims were skipped (already in a different state)", () => {
    expect(historicBulkOutcomeMessage("paid", 5, 3)).toBe(
      "Marked 3 of 5 claims as paid. Undo within 10 minutes reverses the journal entries and returns them to the status they had before.",
    );
  });

  it("nothing changed: no reversal wording even for paid/write-off", () => {
    expect(historicBulkOutcomeMessage("paid", 2, 0)).toBe("Nothing marked as paid.");
    expect(historicBulkOutcomeMessage("writeoff", 2, 0)).toBe("Nothing wrote off.");
  });
});
