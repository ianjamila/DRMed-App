import { describe, it, expect } from "vitest";
import { isFormData } from "./form-data";

describe("isFormData", () => {
  it("accepts a real FormData", () => {
    expect(isFormData(new FormData())).toBe(true);
  });

  it("rejects what a malformed action body decodes to", () => {
    for (const v of [undefined, null, "", "not-form-data", {}, { get: () => "" }, []]) {
      expect(isFormData(v)).toBe(false);
    }
  });
});
