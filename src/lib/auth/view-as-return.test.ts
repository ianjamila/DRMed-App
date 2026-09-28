import { describe, expect, it } from "vitest";
import { safeReturnTo } from "./view-as-return";

describe("safeReturnTo", () => {
  it("keeps a page the new role's sidebar reaches, with its query, without hash", () => {
    expect(safeReturnTo("/staff/appointments?date=2026-09-28#x", "reception")).toBe(
      "/staff/appointments?date=2026-09-28",
    );
  });
  it("keeps detail pages under a reachable page (prefix match)", () => {
    expect(safeReturnTo("/staff/patients/abc", "reception")).toBe("/staff/patients/abc");
  });
  it("sends an admin-only page home for a non-admin role, keeps it for admin", () => {
    expect(safeReturnTo("/staff/users", "reception")).toBe("/staff");
    expect(safeReturnTo("/staff/users", "admin")).toBe("/staff/users");
  });
  it("always allows /staff", () => {
    expect(safeReturnTo("/staff", "xray_technician")).toBe("/staff");
  });
  it.each([
    ["//evil.example/staff"],
    ["https://evil.example/staff"],
    ["/staff\\evil"],
    ["/staffx"],
    ["/patients"],
    ["/staff/../patients"],
    ["/staff/%0d%0aSet-Cookie"],
    [""],
  ])("rejects %s", (raw) => {
    expect(safeReturnTo(raw, "admin")).toBe("/staff");
  });
  it("rejects non-strings", () => {
    expect(safeReturnTo(null, "admin")).toBe("/staff");
    expect(safeReturnTo(new File([], "x"), "admin")).toBe("/staff");
  });
});
