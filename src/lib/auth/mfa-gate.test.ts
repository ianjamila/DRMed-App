import { describe, expect, it } from "vitest";
import { needsMfaChallenge } from "./mfa-gate";

describe("needsMfaChallenge", () => {
  it("challenges a user who has enrolled but has not yet used their factor", () => {
    expect(
      needsMfaChallenge({
        mfaRequired: true,
        currentLevel: "aal1",
        nextLevel: "aal2",
      }),
    ).toBe(true);
  });

  it("lets an enrolled user through once they have cleared the challenge", () => {
    expect(
      needsMfaChallenge({
        mfaRequired: true,
        currentLevel: "aal2",
        nextLevel: "aal2",
      }),
    ).toBe(false);
  });

  // The behaviour change: enrolment is opt-in for EVERY role, admin included.
  // Nobody can be locked out by a lost phone they were forced to enrol.
  it("never forces enrolment on a user with no factor", () => {
    expect(
      needsMfaChallenge({
        mfaRequired: true,
        currentLevel: "aal1",
        nextLevel: "aal1",
      }),
    ).toBe(false);
  });

  it("is disabled wholesale by the feature flag", () => {
    expect(
      needsMfaChallenge({
        mfaRequired: false,
        currentLevel: "aal1",
        nextLevel: "aal2",
      }),
    ).toBe(false);
  });

  it("stays out of the way when the assurance level is unknown", () => {
    expect(
      needsMfaChallenge({
        mfaRequired: true,
        currentLevel: null,
        nextLevel: null,
      }),
    ).toBe(false);
  });
});
