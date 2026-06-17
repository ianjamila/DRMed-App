import { describe, it, expect } from "vitest";
import { RecoverIdSchema } from "./schema";

describe("RecoverIdSchema", () => {
  it("accepts a valid payload", () => {
    expect(RecoverIdSchema.safeParse({ last_name: "Cruz", email: "A@X.com", birthdate: "1990-01-01" }).success).toBe(true);
  });
  it("lowercases the email", () => {
    const r = RecoverIdSchema.parse({ last_name: "Cruz", email: "A@X.com", birthdate: "1990-01-01" });
    expect(r.email).toBe("a@x.com");
  });
  it("rejects a filled honeypot", () => {
    expect(RecoverIdSchema.safeParse({ last_name: "Cruz", email: "a@x.com", birthdate: "1990-01-01", company: "bot" }).success).toBe(false);
  });
  it("rejects a bad date", () => {
    expect(RecoverIdSchema.safeParse({ last_name: "Cruz", email: "a@x.com", birthdate: "01/01/1990" }).success).toBe(false);
  });
});
