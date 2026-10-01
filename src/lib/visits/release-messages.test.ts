import { describe, expect, it } from "vitest";
import { ALREADY_NOTIFIED, NOTICE_RETRYING, releaseUndoMessage } from "./release-messages";

describe("releaseUndoMessage", () => {
  it("counts the tests put back and warns about a notice that went out", () => {
    expect(releaseUndoMessage({ restored: 3, notRestored: [], notified: true })).toBe(
      `Undone — 3 tests are back to Ready for release. ${ALREADY_NOTIFIED}`,
    );
  });
  it("one test, no notice", () => {
    expect(releaseUndoMessage({ restored: 1, notRestored: [], notified: false })).toBe(
      "Undone — 1 test is back to Ready for release.",
    );
  });
  it("names every test not undone, one per line", () => {
    expect(
      releaseUndoMessage({
        restored: 0,
        notRestored: [
          { label: "CBC — Santos, Maria", reason: "changed again since — refresh to see its status" },
          { label: "A test", reason: "part of this report was released separately — undo it from the report page" },
        ],
        notified: true,
      }),
    ).toBe(
      [
        "Nothing was undone.",
        "Not undone (2):",
        "• CBC — Santos, Maria: changed again since — refresh to see its status",
        "• A test: part of this report was released separately — undo it from the report page",
      ].join("\n"),
    );
  });
  it("a partial undo says how many were restored, then lists the rest", () => {
    expect(
      releaseUndoMessage({
        restored: 2,
        notRestored: [{ label: "CBC — Santos, Maria", reason: "changed again since — refresh to see its status" }],
        notified: false,
      }),
    ).toBe(
      [
        "Undone — 2 tests are back to Ready for release.",
        "Not undone (1):",
        "• CBC — Santos, Maria: changed again since — refresh to see its status",
      ].join("\n"),
    );
  });
  it("keeps the shared wording the visit bar used", () => {
    expect(ALREADY_NOTIFIED).toBe("The patient was already notified that results are ready — tell them if needed.");
    expect(NOTICE_RETRYING).toBe(
      "The patient's \"result ready\" message has not gone out yet — it will retry automatically.",
    );
  });
});
