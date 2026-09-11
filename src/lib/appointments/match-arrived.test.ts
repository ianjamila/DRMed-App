import { describe, expect, it } from "vitest";
import { matchArrivedAppointmentsForServices } from "./match-arrived";

describe("matchArrivedAppointmentsForServices", () => {
  it("matches only appointments whose service is among the visit's services", () => {
    const arrived = [
      { id: "appt-lab", service_id: "svc-lab" },
      { id: "appt-consult", service_id: "svc-consult" },
    ];
    const ids = matchArrivedAppointmentsForServices(arrived, ["svc-lab"]);
    expect(ids).toEqual(["appt-lab"]);
  });

  it("leaves an unrelated arrived appointment open — the core Finding 9 case", () => {
    // Patient arrived for both a lab visit and a separate doctor
    // consultation; reception starts only the lab visit.
    const arrived = [
      { id: "appt-lab", service_id: "svc-lab" },
      { id: "appt-consult", service_id: "svc-consult" },
    ];
    const ids = matchArrivedAppointmentsForServices(arrived, ["svc-lab"]);
    expect(ids).not.toContain("appt-consult");
  });

  it("matches every appointment when the visit covers all of them", () => {
    const arrived = [
      { id: "a1", service_id: "svc-1" },
      { id: "a2", service_id: "svc-2" },
    ];
    const ids = matchArrivedAppointmentsForServices(arrived, ["svc-1", "svc-2"]);
    expect(new Set(ids)).toEqual(new Set(["a1", "a2"]));
  });

  it("returns nothing when the visit covers no services", () => {
    const arrived = [{ id: "a1", service_id: "svc-1" }];
    expect(matchArrivedAppointmentsForServices(arrived, [])).toEqual([]);
  });

  it("returns nothing when there are no arrived appointments", () => {
    expect(matchArrivedAppointmentsForServices([], ["svc-1"])).toEqual([]);
  });

  it("never matches a null service_id, leaving it open rather than guessing", () => {
    const arrived = [{ id: "a1", service_id: null }];
    expect(matchArrivedAppointmentsForServices(arrived, ["svc-1"])).toEqual([]);
  });

  it("matches multiple arrived rows for the same service (duplicate bookings)", () => {
    const arrived = [
      { id: "a1", service_id: "svc-1" },
      { id: "a2", service_id: "svc-1" },
    ];
    const ids = matchArrivedAppointmentsForServices(arrived, ["svc-1"]);
    expect(new Set(ids)).toEqual(new Set(["a1", "a2"]));
  });
});
