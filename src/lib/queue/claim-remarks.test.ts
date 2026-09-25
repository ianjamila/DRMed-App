import { describe, expect, it } from "vitest";
import { claimRemarks, eventsByTest, handedBack, type ClaimEvent } from "./claim-remarks";

const T1 = "00000000-0000-0000-0000-000000000001";
const T2 = "00000000-0000-0000-0000-000000000002";

function ev(p: Partial<ClaimEvent>): ClaimEvent {
  return {
    test_request_id: T1,
    action: "test_request.claimed",
    created_at: "2026-09-24T08:31:00.000Z",
    actor_name: "Melvin",
    previous_holder_name: null,
    new_holder_name: null,
    reason: null,
    ...p,
  };
}

describe("claimRemarks", () => {
  it("tells the claim-then-unclaim story oldest first, with the reason", () => {
    const out = claimRemarks([
      ev({ action: "test_request.unclaimed", created_at: "2026-09-24T08:40:00.000Z", previous_holder_name: "Melvin", reason: "wrong patient" }),
      ev({}),
    ]);
    expect(out.map((r) => r.text)).toEqual([
      "Claimed by Melvin",
      "Unclaimed by Melvin — “wrong patient”",
    ]);
    expect(out.map((r) => r.notable)).toEqual([false, true]);
  });

  it("names both people when an admin takes someone else's claim off them", () => {
    const [r] = claimRemarks([
      ev({ action: "test_request.unclaimed", actor_name: "Ian", previous_holder_name: "Melvin" }),
    ]);
    expect(r.text).toBe("Ian unclaimed Melvin’s claim");
  });

  it("describes a reassignment", () => {
    const [r] = claimRemarks([
      ev({ action: "test_request.reassigned", actor_name: "Ian", previous_holder_name: "Alyssa", new_holder_name: "Melvin" }),
    ]);
    expect(r.text).toBe("Reassigned Alyssa → Melvin by Ian");
  });

  it("collapses a group claim written once per member test into one line", () => {
    const out = claimRemarks([ev({}), ev({ test_request_id: T2 })]);
    expect(out).toHaveLength(1);
  });

  it("reads the early `test_request.claim` spelling and ignores unknown actions", () => {
    const out = claimRemarks([ev({ action: "test_request.claim" }), ev({ action: "result.finalised" })]);
    expect(out.map((r) => r.text)).toEqual(["Claimed by Melvin"]);
  });

  it("falls back to 'someone' for a missing staff name", () => {
    const [r] = claimRemarks([ev({ actor_name: null })]);
    expect(r.text).toBe("Claimed by someone");
  });
});

describe("eventsByTest", () => {
  it("groups rows by test id and tolerates null", () => {
    expect(eventsByTest(null).size).toBe(0);
    const m = eventsByTest([ev({}), ev({ test_request_id: T2 }), ev({})]);
    expect(m.get(T1)).toHaveLength(2);
    expect(m.get(T2)).toHaveLength(1);
  });
});

describe("handedBack", () => {
  it("is null for a test that was only ever claimed or reassigned", () => {
    expect(handedBack([ev({}), ev({ action: "test_request.reassigned" })])).toBeNull();
  });

  it("counts unclaims and returns the newest, worded, with its reason", () => {
    const out = handedBack([
      ev({ action: "test_request.unclaimed", created_at: "2026-09-24T08:40:00.000Z", previous_holder_name: "Melvin", reason: "wrong patient" }),
      ev({}),
      ev({ action: "test_request.unclaimed", created_at: "2026-09-24T09:10:00.000Z", actor_name: "Ian", previous_holder_name: "Melvin", reason: "end of shift" }),
    ]);
    expect(out?.count).toBe(2);
    expect(out?.latest.text).toBe("Ian unclaimed Melvin’s claim — “end of shift”");
  });
});
