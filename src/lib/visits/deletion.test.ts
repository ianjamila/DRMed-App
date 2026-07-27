import { describe, expect, it } from "vitest";
import {
  testDeletability,
  visitDeletability,
  type TestDeleteShape,
  type VisitDeleteShape,
} from "./deletion";

function visit(overrides: Partial<VisitDeleteShape> = {}): VisitDeleteShape {
  return {
    payment_status: "unpaid",
    deleted_at: null,
    test_statuses: ["requested", "in_progress"],
    ...overrides,
  };
}

function test_(overrides: Partial<TestDeleteShape> = {}): TestDeleteShape {
  return {
    status: "requested",
    deleted_at: null,
    parent_id: null,
    visit_payment_status: "unpaid",
    visit_deleted_at: null,
    ...overrides,
  };
}

describe("visitDeletability", () => {
  it("allows reception and admin on an unpaid visit", () => {
    expect(visitDeletability("reception", visit()).ok).toBe(true);
    expect(visitDeletability("admin", visit()).ok).toBe(true);
  });

  it("blocks medtech and pathologist regardless of state", () => {
    for (const role of ["medtech", "pathologist", "xray_technician"]) {
      const d = visitDeletability(role, visit());
      expect(d).toMatchObject({ ok: false, reason: "role" });
    }
  });

  it("blocks partial and paid visits as has_payments (void-first flow)", () => {
    for (const status of ["partial", "paid"]) {
      const d = visitDeletability("admin", visit({ payment_status: status }));
      expect(d).toMatchObject({ ok: false, reason: "has_payments" });
    }
  });

  it("blocks waived visits with the dedicated reason", () => {
    expect(
      visitDeletability("admin", visit({ payment_status: "waived" })),
    ).toMatchObject({ ok: false, reason: "waived" });
  });

  it("blocks a visit that already has a released result", () => {
    expect(
      visitDeletability(
        "admin",
        visit({ test_statuses: ["released", "requested"] }),
      ),
    ).toMatchObject({ ok: false, reason: "released" });
  });

  it("blocks an already-deleted visit", () => {
    expect(
      visitDeletability("admin", visit({ deleted_at: "2026-07-27T00:00:00Z" })),
    ).toMatchObject({ ok: false, reason: "already_deleted" });
  });

  it("cancelled tests do not block deletion", () => {
    expect(
      visitDeletability("reception", visit({ test_statuses: ["cancelled"] })).ok,
    ).toBe(true);
  });
});

describe("testDeletability", () => {
  it("allows reception/admin on an unpaid standalone test or package header", () => {
    expect(testDeletability("reception", test_()).ok).toBe(true);
    expect(testDeletability("admin", test_()).ok).toBe(true);
  });

  it("blocks package components — whole package only", () => {
    expect(
      testDeletability("admin", test_({ parent_id: "some-header-id" })),
    ).toMatchObject({ ok: false, reason: "package_component" });
  });

  it("blocks released tests", () => {
    expect(
      testDeletability("admin", test_({ status: "released" })),
    ).toMatchObject({ ok: false, reason: "released" });
  });

  it("blocks when the visit has payments or is waived", () => {
    expect(
      testDeletability("admin", test_({ visit_payment_status: "partial" })),
    ).toMatchObject({ ok: false, reason: "has_payments" });
    expect(
      testDeletability("admin", test_({ visit_payment_status: "waived" })),
    ).toMatchObject({ ok: false, reason: "waived" });
  });

  it("treats a test on a deleted visit as already deleted", () => {
    expect(
      testDeletability(
        "reception",
        test_({ visit_deleted_at: "2026-07-27T00:00:00Z" }),
      ),
    ).toMatchObject({ ok: false, reason: "already_deleted" });
  });

  it("blocks non-reception/admin roles", () => {
    expect(testDeletability("medtech", test_())).toMatchObject({
      ok: false,
      reason: "role",
    });
  });
});
