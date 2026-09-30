import { describe, expect, it } from "vitest";
import {
  benchHeldAsSeen,
  panelActionLabel,
  seenBench,
  summarizePanel,
  type PanelMember,
} from "./panel-members";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NONE = new Set<string>();

function member(id: string, over: Partial<PanelMember> = {}): PanelMember {
  return {
    id,
    status: "requested",
    assignedTo: null,
    section: "chemistry",
    parentId: null,
    visitPaymentStatus: "paid",
    visitHmoProviderId: null,
    hasOpenHmoClaim: false,
    resultId: null,
    hasPdf: false,
    ...over,
  };
}

const medtech = { role: "medtech" as const, userId: ME, sharedReportIds: NONE };
const admin = { role: "admin" as const, userId: ME, sharedReportIds: NONE };

describe("summarizePanel — claim", () => {
  it("offers Claim when every bench member is requested and unassigned", () => {
    const s = summarizePanel([member("a"), member("b")], medtech);
    expect(s.claimable).toBe(true);
    expect(s.benchIds).toEqual(["a", "b"]);
  });

  it("refuses Claim when ONE member is already held — even one the page didn't show", () => {
    // The Unclaimed tab hides "b"; the card shows only "a". The whole panel decides.
    const s = summarizePanel(
      [member("a"), member("b", { status: "in_progress", assignedTo: OTHER })],
      medtech,
    );
    expect(s.claimable).toBe(false);
    expect(s.unclaimable).toBe(false);
  });

  it("refuses Claim while the visit is waiting for payment (Pending release is ungated)", () => {
    const unpaid = { visitPaymentStatus: "unpaid" };
    expect(summarizePanel([member("a", unpaid), member("b", unpaid)], medtech).claimable).toBe(false);
    // An HMO visit never pays at the counter — it passes the lab gate.
    expect(
      summarizePanel([member("a", { ...unpaid, visitHmoProviderId: "hmo-1" })], medtech).claimable,
    ).toBe(true);
  });

  it("refuses Claim outside the role's sections (reception has none)", () => {
    const s = summarizePanel([member("a")], { ...medtech, role: "reception" });
    expect(s.claimable).toBe(false);
  });

  it("claims only the bench: a member on a finished report is left out", () => {
    const s = summarizePanel(
      [
        member("done", { status: "ready_for_release", resultId: "r1", hasPdf: true }),
        member("new"),
      ],
      medtech,
    );
    expect(s.benchIds).toEqual(["new"]);
    expect(s.allIds).toEqual(["done", "new"]);
    expect(s.claimable).toBe(true);
  });

  it("has nothing to claim when no member is on the bench", () => {
    const s = summarizePanel(
      [member("done", { status: "released", resultId: "r1", hasPdf: true })],
      medtech,
    );
    expect(s.benchIds).toEqual([]);
    expect(s.claimable).toBe(false);
  });
});

describe("summarizePanel — unclaim", () => {
  const held = (holder: string) => [
    member("a", { status: "in_progress", assignedTo: holder }),
    member("b", { status: "in_progress", assignedTo: holder }),
  ];

  it("lets the holder hand back their own panel", () => {
    const s = summarizePanel(held(ME), medtech);
    expect(s.unclaimable).toBe(true);
    expect(s.holder).toBe(ME);
  });

  it("lets an admin hand back anyone's panel, and nobody else", () => {
    expect(summarizePanel(held(OTHER), admin).unclaimable).toBe(true);
    expect(summarizePanel(held(OTHER), medtech).unclaimable).toBe(false);
  });

  it("lets an admin recover a panel split between two holders — per-member holders — but not the holder of half of it", () => {
    const split = [
      member("a", { status: "in_progress", assignedTo: ME }),
      member("b", { status: "in_progress", assignedTo: OTHER }),
    ];
    const s = summarizePanel(split, admin);
    expect(s.holder).toBeNull();
    expect(s.unclaimable).toBe(true);
    expect(s.benchHolders).toEqual([ME, OTHER]);
    expect(summarizePanel(split, medtech).unclaimable).toBe(false);
  });

  it("refuses once any member has a result uploaded", () => {
    const s = summarizePanel(
      [
        member("a", { status: "in_progress", assignedTo: ME }),
        member("b", { status: "result_uploaded", assignedTo: ME }),
      ],
      medtech,
    );
    expect(s.unclaimable).toBe(false);
  });
});

describe("summarizePanel — delete", () => {
  const unpaid = { visitPaymentStatus: "unpaid" };

  it("offers Delete to admin when every member is deletable", () => {
    expect(summarizePanel([member("a", unpaid), member("b", unpaid)], admin).deletable).toBe(true);
  });

  it("never offers Delete to a lab role", () => {
    expect(summarizePanel([member("a", unpaid)], medtech).deletable).toBe(false);
  });

  it("refuses Delete when ANY member is locked (paid visit, HMO claim, shared report)", () => {
    expect(
      summarizePanel([member("a", unpaid), member("b", { visitPaymentStatus: "paid" })], admin)
        .deletable,
    ).toBe(false);
    expect(
      summarizePanel([member("a", unpaid), member("b", { ...unpaid, hasOpenHmoClaim: true })], admin)
        .deletable,
    ).toBe(false);
    expect(
      summarizePanel([member("a", unpaid), member("b", unpaid)], {
        ...admin,
        sharedReportIds: new Set(["b"]),
      }).deletable,
    ).toBe(false);
  });
});

describe("benchHeldAsSeen — Unclaim acts only on the bench the operator saw", () => {
  const C = "33333333-3333-4333-8333-333333333333";
  const split = { benchIds: ["a", "b"], benchHolders: [ME, OTHER] };

  it("accepts the exact members and holders the page rendered", () => {
    expect(benchHeldAsSeen(split, seenBench(split))).toBe(true);
  });

  it("refuses a split panel reassigned to a third holder — the summary holder is null both times", () => {
    const now = { benchIds: ["a", "b"], benchHolders: [ME, C] };
    expect(benchHeldAsSeen(now, seenBench(split))).toBe(false);
  });

  it("refuses when a member joined or left the bench since the page rendered", () => {
    expect(benchHeldAsSeen({ benchIds: ["a", "b", "c"], benchHolders: [ME, OTHER, null] }, seenBench(split))).toBe(false);
    expect(benchHeldAsSeen({ benchIds: ["a"], benchHolders: [ME] }, seenBench(split))).toBe(false);
  });

  it("refuses a seen list that repeats a member to pad the count", () => {
    const now = { benchIds: ["a", "b"], benchHolders: [ME, ME] };
    expect(benchHeldAsSeen(now, [{ id: "a", holder: ME }, { id: "a", holder: ME }])).toBe(false);
  });
});

describe("panelActionLabel — confirmations name the whole panel", () => {
  it("counts every test the action touches", () => {
    expect(panelActionLabel("Chemistry", ["a", "b", "c"], ["a", "b", "c"])).toBe("Chemistry (3 tests)");
    expect(panelActionLabel("Chemistry", ["a"], ["a"])).toBe("Chemistry (1 test)");
  });

  it("says when some of those tests are on another page", () => {
    expect(panelActionLabel("Chemistry", ["a", "b", "c"], ["a"])).toBe(
      "Chemistry (3 tests), including 2 not shown on this page",
    );
  });

  it("does not count a shown member the action leaves alone as hidden", () => {
    // A finished-report member is on the page but not on the bench.
    expect(panelActionLabel("Chemistry", ["a", "b"], ["a", "done"])).toBe(
      "Chemistry (2 tests), including 1 not shown on this page",
    );
  });
});
