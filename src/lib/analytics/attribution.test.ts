import { describe, expect, it } from "vitest";
import {
  ATTRIBUTION_MAX_AGE_SECONDS,
  attributionFromSearchParams,
  parseAttributionCookie,
} from "./attribution";

const params = (qs: string) => new URLSearchParams(qs);

describe("attributionFromSearchParams", () => {
  it("returns null when the URL carries no utm_* params", () => {
    expect(attributionFromSearchParams(params(""), "/")).toBeNull();
    expect(
      attributionFromSearchParams(params("ref=facebook&fbclid=abc"), "/"),
    ).toBeNull();
  });

  it("captures every supported utm key plus the landing path", () => {
    const result = attributionFromSearchParams(
      params(
        "utm_source=facebook&utm_medium=paid&utm_campaign=c1_annual_pe" +
          "&utm_content=carousel_a&utm_term=executive+checkup",
      ),
      "/packages/annual-physical-exam",
    );

    expect(result).toMatchObject({
      utm_source: "facebook",
      utm_medium: "paid",
      utm_campaign: "c1_annual_pe",
      utm_content: "carousel_a",
      utm_term: "executive checkup",
      landing_path: "/packages/annual-physical-exam",
    });
  });

  it("captures a partial set without inventing the missing keys", () => {
    const result = attributionFromSearchParams(
      params("utm_source=facebook&utm_campaign=c7_hmo"),
      "/contact",
    );

    expect(result?.utm_source).toBe("facebook");
    expect(result?.utm_campaign).toBe("c7_hmo");
    expect(result).not.toHaveProperty("utm_medium");
    expect(result).not.toHaveProperty("utm_term");
  });

  it("stamps an ISO captured_at timestamp", () => {
    const result = attributionFromSearchParams(params("utm_source=ig"), "/");
    expect(result?.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it("truncates oversized values so the cookie can't be inflated by a crafted URL", () => {
    const result = attributionFromSearchParams(
      params(`utm_campaign=${"x".repeat(5000)}`),
      "/",
    );
    expect(result?.utm_campaign).toHaveLength(200);
  });

  it("ignores empty-string utm values rather than treating them as a hit", () => {
    expect(attributionFromSearchParams(params("utm_source="), "/")).toBeNull();
  });

  it("keeps the last-touch window at 30 days", () => {
    expect(ATTRIBUTION_MAX_AGE_SECONDS).toBe(60 * 60 * 24 * 30);
  });
});

describe("parseAttributionCookie", () => {
  it("returns null for a missing cookie", () => {
    expect(parseAttributionCookie(undefined)).toBeNull();
    expect(parseAttributionCookie("")).toBeNull();
  });

  it("returns null for malformed JSON instead of throwing", () => {
    expect(parseAttributionCookie("{not json")).toBeNull();
  });

  it("returns null for valid JSON that isn't an attribution object", () => {
    expect(parseAttributionCookie('"just a string"')).toBeNull();
    expect(parseAttributionCookie("42")).toBeNull();
    expect(parseAttributionCookie("null")).toBeNull();
    expect(parseAttributionCookie('["utm_source"]')).toBeNull();
  });

  it("round-trips what the proxy writes", () => {
    const captured = attributionFromSearchParams(
      params("utm_source=facebook&utm_campaign=c1_annual_pe"),
      "/schedule",
    );
    expect(parseAttributionCookie(JSON.stringify(captured))).toEqual(captured);
  });
});
