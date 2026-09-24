import { describe, expect, it } from "vitest";
import { computeResortGroups } from "./resort";

const pt = (id: string, answer: string, current: string | null, origin: "staff" | "sheet" | "patient" | null = current ? "staff" : null) =>
  ({ id, answer, referral_source: current, referral_source_origin: origin });

describe("computeResortGroups", () => {
  it("groups patients whose value still equals the old mapper's output", () => {
    const g = computeResortGroups([
      pt("a", "Family / Friends", "customer_referral"),
      pt("b", "FAMILY/FRIENDS", "customer_referral"),
      pt("c", "Family / Friends", "walk_in"),            // staff changed it → excluded
    ], new Map());
    expect(g.groups).toEqual([{ answerNorm: "FAMILY FRIENDS", sampleAnswer: "Family / Friends", from: "customer_referral",
      to: "family_friends", patientIds: ["a", "b"] }]);
    expect(g.keptByStaff).toBe(1);
  });
  it("blank answers now map to Not recorded (null)", () => {
    const g = computeResortGroups([pt("a", "", "other")], new Map());
    expect(g.groups[0]).toMatchObject({ from: "other", to: null });
  });
  it("never proposes a downgrade to 'other' (D8)", () => {
    const g = computeResortGroups([pt("a", "CUSTOMER LIST", "customer_referral")], new Map());
    expect(g.groups).toEqual([]);
  });
  it("skips values already right and patient-owned values", () => {
    const g = computeResortGroups([pt("a", "FACEBOOK", "online_facebook"), pt("b", "WALK IN", "walk_in", "patient")], new Map());
    expect(g.groups).toEqual([]);
  });
});
