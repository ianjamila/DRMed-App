import { describe, expect, it } from "vitest";
import { deriveEnabledParamIds } from "./enabled-params";

const links = [
  // BUA_URIC_ACID enables BOTH gendered Uric Acid rows.
  { service_id: "svc-bua", parameter_id: "param-uric-f" },
  { service_id: "svc-bua", parameter_id: "param-uric-m" },
  { service_id: "svc-fbs", parameter_id: "param-fbs" },
  { service_id: "svc-lipid", parameter_id: "param-chol" },
  { service_id: "svc-lipid", parameter_id: "param-hdl" },
];

describe("deriveEnabledParamIds", () => {
  it("enables exactly the params linked to ordered services", () => {
    const out = deriveEnabledParamIds(links, ["svc-fbs"]);
    expect(out).toEqual(new Set(["param-fbs"]));
  });

  it("gendered duplicates: one service enables both rows", () => {
    const out = deriveEnabledParamIds(links, ["svc-bua"]);
    expect(out).toEqual(new Set(["param-uric-f", "param-uric-m"]));
  });

  it("package headers (no mapping rows) contribute nothing", () => {
    // LIPID_PROFILE_PACKAGE has no rows by design — components carry encoding.
    const out = deriveEnabledParamIds(links, ["svc-lipid-package", "svc-lipid"]);
    expect(out).toEqual(new Set(["param-chol", "param-hdl"]));
  });

  it("unions across multiple ordered services", () => {
    const out = deriveEnabledParamIds(links, ["svc-fbs", "svc-lipid"]);
    expect(out).toEqual(new Set(["param-fbs", "param-chol", "param-hdl"]));
  });

  it("empty inputs produce an empty set", () => {
    expect(deriveEnabledParamIds([], ["svc-fbs"])).toEqual(new Set());
    expect(deriveEnabledParamIds(links, [])).toEqual(new Set());
  });

  it("duplicate links and duplicate ordered service ids absorb into the set", () => {
    const dupLinks = [...links, { service_id: "svc-fbs", parameter_id: "param-fbs" }];
    const out = deriveEnabledParamIds(dupLinks, ["svc-fbs", "svc-fbs"]);
    expect(out).toEqual(new Set(["param-fbs"]));
  });
});
