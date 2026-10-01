import { describe, expect, it } from "vitest";
import {
  STAFF_STATUS_TARGETS,
  STATUS_TRANSITIONS,
  canTransition,
  transitionTargets,
} from "./status-transitions";
import { CONTACT_MESSAGE_STATUSES } from "./labels";

// Spec §7's matrix — the detail page's buttons, the bulk bar and the bulk
// server action all read this one table, so they cannot drift.
describe("status transitions", () => {
  it("matches the detail page's matrix exactly, in button order", () => {
    expect(STATUS_TRANSITIONS).toEqual({
      new: ["replied", "closed"],
      replied: ["closed", "new"],
      booked: ["closed", "new"],
      closed: ["new"],
    });
  });

  it("covers every stored status", () => {
    for (const s of CONTACT_MESSAGE_STATUSES) expect(STATUS_TRANSITIONS[s]).toBeDefined();
  });

  it("never offers booked as a staff target (only the booking flow sets it)", () => {
    expect(STAFF_STATUS_TARGETS).toEqual(["new", "replied", "closed"]);
    for (const s of CONTACT_MESSAGE_STATUSES) expect(transitionTargets(s)).not.toContain("booked");
  });

  it("canTransition follows the matrix and refuses unknown or same-status moves", () => {
    expect(canTransition("new", "replied")).toBe(true);
    expect(canTransition("booked", "replied")).toBe(false);
    expect(canTransition("closed", "closed")).toBe(false);
    expect(canTransition("closed", "replied")).toBe(false);
    expect(canTransition("bogus", "new")).toBe(false);
  });

  it("transitionTargets of an unknown status is empty", () => {
    expect(transitionTargets("bogus")).toEqual([]);
  });
});
