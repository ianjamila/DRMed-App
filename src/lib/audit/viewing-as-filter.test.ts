import { describe, expect, it } from "vitest";
import { parseViewingAsFilter, viewingAsLabel } from "./viewing-as-filter";

describe("parseViewingAsFilter", () => {
  it("resolves 'any' to the any-role-view sentinel", () => {
    expect(parseViewingAsFilter("any")).toBe("any");
  });

  it("resolves each of the four View-as roles", () => {
    expect(parseViewingAsFilter("reception")).toBe("reception");
    expect(parseViewingAsFilter("medtech")).toBe("medtech");
    expect(parseViewingAsFilter("xray_technician")).toBe("xray_technician");
    expect(parseViewingAsFilter("pathologist")).toBe("pathologist");
  });

  it("falls back to null for unset", () => {
    expect(parseViewingAsFilter(undefined)).toBeNull();
  });

  it("falls back to null for an unknown value", () => {
    expect(parseViewingAsFilter("bogus")).toBeNull();
  });

  it("falls back to null for 'admin' — never a valid acting_as value", () => {
    expect(parseViewingAsFilter("admin")).toBeNull();
  });

  it("falls back to null for the empty string", () => {
    expect(parseViewingAsFilter("")).toBeNull();
  });
});

describe("viewingAsLabel", () => {
  it("labels each of the four View-as roles", () => {
    expect(viewingAsLabel("reception")).toBe("Reception");
    expect(viewingAsLabel("medtech")).toBe("Medical Tech");
    expect(viewingAsLabel("xray_technician")).toBe("X-ray Technician");
    expect(viewingAsLabel("pathologist")).toBe("Pathologist");
  });

  it("is blank for a missing acting_as", () => {
    expect(viewingAsLabel(undefined)).toBe("—");
    expect(viewingAsLabel(null)).toBe("—");
  });

  it("is blank for an unrecognised acting_as", () => {
    expect(viewingAsLabel("bogus")).toBe("—");
    expect(viewingAsLabel("admin")).toBe("—");
    expect(viewingAsLabel(42)).toBe("—");
  });
});
