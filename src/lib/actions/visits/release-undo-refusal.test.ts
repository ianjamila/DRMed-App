import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { makeFakeReleaseDb, FAKE_RELEASED_AT } from "./fake-release-db";
import { idsWithMateReleasedOutsideBatch, RELEASED_SEPARATELY_REASON } from "./release-undo-refusal";

const REL = { status: "released", releasedAt: FAKE_RELEASED_AT } as const;
const links = [
  { testRequestId: "a", resultId: "r1" },
  { testRequestId: "b", resultId: "r1" },
  { testRequestId: "c", resultId: "r2" },
  { testRequestId: "d", resultId: "r2" },
];

describe("idsWithMateReleasedOutsideBatch", () => {
  it("flags every refused batch id whose report has a live released member outside the batch", async () => {
    const fake = makeFakeReleaseDb({ rows: ["a", "b", "c", "d"].map((id) => ({ id, ...REL })), links });
    // Batch released a and c,d; b (a's mate) was released separately.
    const got = await idsWithMateReleasedOutsideBatch(fake.client, ["a", "c"], new Set(["a", "c", "d"]));
    expect([...got]).toEqual(["a"]);
  });
  it("a mate outside the batch that is no longer released (or deleted) does not count", async () => {
    const fake = makeFakeReleaseDb({
      rows: [{ id: "a", ...REL }, { id: "b", status: "ready_for_release" }],
      links: links.slice(0, 2),
    });
    expect([...(await idsWithMateReleasedOutsideBatch(fake.client, ["a"], new Set(["a"])))]).toEqual([]);
    const fake2 = makeFakeReleaseDb({ rows: [{ id: "a", ...REL }, { id: "b", ...REL, deleted: true }], links: links.slice(0, 2) });
    expect([...(await idsWithMateReleasedOutsideBatch(fake2.client, ["a"], new Set(["a"])))]).toEqual([]);
  });
  it("a mate on a deleted visit does not count", async () => {
    const fake = makeFakeReleaseDb({ rows: [{ id: "a", ...REL }, { id: "b", ...REL, visitDeleted: true }], links: links.slice(0, 2) });
    expect([...(await idsWithMateReleasedOutsideBatch(fake.client, ["a"], new Set(["a"])))]).toEqual([]);
  });
  it("a plain line (no report) is never flagged; no ids means no read", async () => {
    const fake = makeFakeReleaseDb({ rows: [{ id: "x", ...REL }] });
    expect([...(await idsWithMateReleasedOutsideBatch(fake.client, ["x"], new Set(["x"])))]).toEqual([]);
    expect([...(await idsWithMateReleasedOutsideBatch(fake.client, [], new Set()))]).toEqual([]);
    // One membership read for ["x"] (no report -> stop), none for [].
    expect(fake.calls.map((c) => c.table)).toEqual(["result_test_requests"]);
  });
  it("never throws: a failed read flags nothing (the caller keeps the generic reason)", async () => {
    const fake = makeFakeReleaseDb({ rows: ["a", "b"].map((id) => ({ id, ...REL })), links: links.slice(0, 2) });
    fake.failNext("result_test_requests", "read");
    expect([...(await idsWithMateReleasedOutsideBatch(fake.client, ["a"], new Set(["a"])))]).toEqual([]);
  });
  it("the wording", () => {
    expect(RELEASED_SEPARATELY_REASON).toBe("part of this report was released separately — undo it from the report page");
  });
});
