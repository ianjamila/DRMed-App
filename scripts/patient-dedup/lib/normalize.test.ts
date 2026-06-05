// scripts/patient-dedup/lib/normalize.test.ts
import { describe, it, expect } from "vitest";
import { phoneKey, emailKey, matchKey } from "./normalize";

describe("phoneKey", () => {
  it("strips non-digits", () => {
    expect(phoneKey("0917-123 4567")).toBe("09171234567");
  });
  it("returns null for too-short / empty / nullish", () => {
    expect(phoneKey("123")).toBeNull();
    expect(phoneKey("")).toBeNull();
    expect(phoneKey(null)).toBeNull();
    expect(phoneKey(undefined)).toBeNull();
  });
});

describe("emailKey", () => {
  it("lowercases and trims", () => {
    expect(emailKey("  Foo@Bar.COM ")).toBe("foo@bar.com");
  });
  it("returns null for empty / nullish", () => {
    expect(emailKey("   ")).toBeNull();
    expect(emailKey(null)).toBeNull();
  });
});

describe("matchKey re-export", () => {
  it("is the backfill matcher (surname + first given token)", () => {
    expect(matchKey("Blancaflor", "Elmer Jr")).toBe("blancaflor|elmer");
  });
});
