import { describe, it, expect } from "vitest";
import { parseNewRepeat } from "./new-repeat";

describe("parseNewRepeat", () => {
  it("maps new/repeat variants", () => {
    expect(parseNewRepeat("NEW")).toBe("new");
    expect(parseNewRepeat("new customer")).toBe("new");
    expect(parseNewRepeat("N")).toBe("new");
    expect(parseNewRepeat("REPEAT")).toBe("repeat");
    expect(parseNewRepeat("Repeat Customer")).toBe("repeat");
    expect(parseNewRepeat("R")).toBe("repeat");
  });
  it("returns null for blank/unknown", () => {
    expect(parseNewRepeat("")).toBeNull();
    expect(parseNewRepeat("   ")).toBeNull();
    expect(parseNewRepeat("N/A")).toBeNull();
  });
});
