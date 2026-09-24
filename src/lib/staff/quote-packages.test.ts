import { describe, it, expect } from "vitest";
import { packageContents, coveredByPickedPackage } from "./quote-packages";

const comp = (id: string, name: string) => ({ id, name });

describe("packageContents", () => {
  it("groups tests under their package in the package's own order", () => {
    const map = packageContents([
      { package_service_id: "exec", sort_order: 2, component: comp("fbs", "FBS/RBS") },
      { package_service_id: "lipid", sort_order: 1, component: comp("chol", "Cholesterol") },
      { package_service_id: "exec", sort_order: 1, component: comp("cbc", "CBC + PC") },
    ]);
    expect(map.get("exec")).toEqual([comp("cbc", "CBC + PC"), comp("fbs", "FBS/RBS")]);
    expect(map.get("lipid")).toEqual([comp("chol", "Cholesterol")]);
  });

  it("breaks a sort_order tie by name, so the list is stable between loads", () => {
    const map = packageContents([
      { package_service_id: "p", sort_order: 0, component: comp("u", "Urinalysis") },
      { package_service_id: "p", sort_order: 0, component: comp("b", "BUN") },
    ]);
    expect(map.get("p")?.map((t) => t.name)).toEqual(["BUN", "Urinalysis"]);
  });

  it("accepts the one-element-array embed shape and drops unreadable components", () => {
    const map = packageContents([
      { package_service_id: "p", sort_order: 1, component: [comp("cbc", "CBC")] },
      { package_service_id: "p", sort_order: 2, component: null },
      { package_service_id: "p", sort_order: 3, component: [] },
    ]);
    expect(map.get("p")).toEqual([comp("cbc", "CBC")]);
  });

  it("has no entry for a package with no readable tests", () => {
    expect(packageContents([]).size).toBe(0);
  });
});

describe("coveredByPickedPackage", () => {
  const exec = { id: "exec", name: "Executive Package", includes: [comp("cbc", "CBC"), comp("fbs", "FBS")] };
  const cbc = { id: "cbc", name: "CBC", includes: [] };
  const xray = { id: "xray", name: "Chest X-Ray", includes: [] };

  it("flags a picked test that a picked package already includes", () => {
    expect(coveredByPickedPackage([cbc, exec, xray])).toEqual(new Map([["cbc", "Executive Package"]]));
  });

  it("flags nothing when the package is not picked", () => {
    expect(coveredByPickedPackage([cbc, xray]).size).toBe(0);
  });

  it("names the first picked package when two include the same test", () => {
    const basic = { id: "basic", name: "Basic Package", includes: [comp("cbc", "CBC")] };
    expect(coveredByPickedPackage([basic, exec, cbc]).get("cbc")).toBe("Basic Package");
  });

  it("never flags the package itself, even if it lists itself", () => {
    const odd = { id: "odd", name: "Odd", includes: [comp("odd", "Odd")] };
    expect(coveredByPickedPackage([odd]).size).toBe(0);
  });
});
