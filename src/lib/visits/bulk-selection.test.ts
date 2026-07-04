import { describe, expect, it } from "vitest";
import { scopeToAllowedSections, MAX_BULK_SELECTION } from "./bulk-selection";

const row = (
  id: string,
  section: string | null,
  name = `Service ${id}`,
) => ({ id, services: { section, name } });

describe("scopeToAllowedSections", () => {
  it("passes every row when allowedSections is null (admin/pathologist), including null sections", () => {
    const rows = [
      row("a", "chemistry"),
      row("b", "imaging_xray"),
      row("c", null),
    ];
    expect(scopeToAllowedSections(rows, null)).toEqual([
      { id: "a", name: "Service a" },
      { id: "b", name: "Service b" },
      { id: "c", name: "Service c" },
    ]);
  });

  it("passes nothing when allowedSections is empty (reception)", () => {
    const rows = [row("a", "chemistry"), row("b", null)];
    expect(scopeToAllowedSections(rows, [])).toEqual([]);
  });

  it("filters to the allowed subset only (medtech-style list)", () => {
    const rows = [
      row("a", "chemistry"),
      row("b", "imaging_xray"),
      row("c", "hematology"),
      row("d", "consultation"),
    ];
    expect(
      scopeToAllowedSections(rows, ["chemistry", "hematology"]),
    ).toEqual([
      { id: "a", name: "Service a" },
      { id: "c", name: "Service c" },
    ]);
  });

  it("always filters out rows with a null or missing section when a list applies", () => {
    const rows = [
      row("a", null),
      { id: "b", services: null },
      { id: "c", services: [] },
      row("d", "chemistry"),
    ];
    expect(scopeToAllowedSections(rows, ["chemistry"])).toEqual([
      { id: "d", name: "Service d" },
    ]);
  });

  it("flattens the services embed whether it is an object or an array", () => {
    const objectShape = [row("a", "chemistry", "FBS")];
    const arrayShape = [
      { id: "a", services: [{ section: "chemistry", name: "FBS" }] },
    ];
    const expected = [{ id: "a", name: "FBS" }];
    expect(scopeToAllowedSections(objectShape, ["chemistry"])).toEqual(expected);
    expect(scopeToAllowedSections(arrayShape, ["chemistry"])).toEqual(expected);
  });

  it("keeps the service name even when unrestricted rows have no services embed", () => {
    expect(scopeToAllowedSections([{ id: "a", services: null }], null)).toEqual([
      { id: "a", name: null },
    ]);
  });
});

describe("MAX_BULK_SELECTION", () => {
  it("is a positive cap shared by the server actions and the selection UI", () => {
    expect(MAX_BULK_SELECTION).toBe(100);
  });
});
