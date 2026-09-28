import { describe, expect, it } from "vitest";
import { summarizePanel, type PanelMember } from "./panel-members";

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
    visitPaymentStatus: "unpaid",
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

  it("refuses when the panel is split between two holders", () => {
    const s = summarizePanel(
      [
        member("a", { status: "in_progress", assignedTo: ME }),
        member("b", { status: "in_progress", assignedTo: OTHER }),
      ],
      admin,
    );
    expect(s.holder).toBeNull();
    expect(s.unclaimable).toBe(false);
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
  it("offers Delete to admin when every member is deletable", () => {
    expect(summarizePanel([member("a"), member("b")], admin).deletable).toBe(true);
  });

  it("never offers Delete to a lab role", () => {
    expect(summarizePanel([member("a")], medtech).deletable).toBe(false);
  });

  it("refuses Delete when ANY member is locked (paid visit, HMO claim, shared report)", () => {
    expect(
      summarizePanel([member("a"), member("b", { visitPaymentStatus: "paid" })], admin).deletable,
    ).toBe(false);
    expect(
      summarizePanel([member("a"), member("b", { hasOpenHmoClaim: true })], admin).deletable,
    ).toBe(false);
    expect(
      summarizePanel([member("a"), member("b")], { ...admin, sharedReportIds: new Set(["b"]) })
        .deletable,
    ).toBe(false);
  });
});
