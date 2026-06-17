import { describe, it, expect } from "vitest";
import { nameSimilarity, scorePair, type CandidateFields } from "./duplicates";

describe("nameSimilarity", () => {
  it("is 1 for identical normalized names", () => {
    expect(nameSimilarity("John Cruz", "  john   cruz ")).toBe(1);
  });
  it("is high for a one-letter typo", () => {
    expect(nameSimilarity("Jonathan Cruz", "Jonathon Cruz")).toBeGreaterThan(0.85);
  });
  it("is low for unrelated names", () => {
    expect(nameSimilarity("Maria Santos", "John Cruz")).toBeLessThan(0.4);
  });
  it("is 0 when either side is empty", () => {
    expect(nameSimilarity("", "John")).toBe(0);
  });
});

const base: CandidateFields = {
  first_name: "John", last_name: "Cruz", birthdate: "1990-01-01",
  email: "john@x.com", phone_normalized: "9171234567",
  address: "1 Main St", sex: "male",
};
const clone = (o: Partial<CandidateFields>): CandidateFields => ({ ...base, ...o });

describe("scorePair", () => {
  it("flags exact_dup when email+first+last+birthdate all match", () => {
    const r = scorePair(base, clone({ phone_normalized: null, address: null }));
    expect(r.tier).toBe("exact_dup");
    expect(r.signals).toContain("exact_email");
  });

  it("same email + same birthdate + same last, first typo => strong (not exact_dup)", () => {
    const r = scorePair(base, clone({ first_name: "Jon" }));
    expect(r.tier).toBe("strong");
    expect(r.signals).toContain("exact_email");
  });

  it("same first+last+birthdate, different email => probable or strong, corroborated", () => {
    const r = scorePair(base, clone({ email: "other@x.com", phone_normalized: null }));
    expect(["probable", "strong"]).toContain(r.tier);
  });

  it("FAMILY PHONE: same phone, different surname, different birthdate => never above weak", () => {
    const r = scorePair(
      clone({ first_name: "Ana", last_name: "Reyes", birthdate: "1988-05-05", email: null }),
      clone({ first_name: "Ben", last_name: "Santos", birthdate: "2010-09-09", email: null }),
    );
    expect(r.signals).toContain("same_phone");
    expect(r.tier === "weak" || r.tier === null).toBe(true);
  });

  it("SIBLINGS: same last+phone+address, different first+birthdate => not above weak (no corroboration)", () => {
    const r = scorePair(
      clone({ first_name: "Ana", birthdate: "2008-01-01", email: null }),
      clone({ first_name: "Ben", birthdate: "2010-01-01", email: null }),
    );
    expect(r.tier === "weak" || r.tier === null).toBe(true);
  });

  it("unrelated people => no tier", () => {
    const r = scorePair(
      clone({ first_name: "Ana", last_name: "Reyes", birthdate: "1988-05-05", email: "a@x.com", phone_normalized: "9001112222", address: "X" }),
      clone({ first_name: "Ben", last_name: "Santos", birthdate: "2010-09-09", email: "b@y.com", phone_normalized: "9003334444", address: "Y", sex: "female" }),
    );
    expect(r.tier).toBeNull();
  });

  it("same email only => probable (email corroborates)", () => {
    const r = scorePair(
      clone({ first_name: "Ana", last_name: "Reyes", birthdate: null, phone_normalized: null, address: null, sex: null }),
      clone({ first_name: "Bea", last_name: "Tan", birthdate: null, phone_normalized: null, address: null, sex: null }),
    );
    expect(r.tier).toBe("probable");
  });
});
