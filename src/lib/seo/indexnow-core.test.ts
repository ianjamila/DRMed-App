import { describe, it, expect } from "vitest";
import {
  buildIndexNowPayload,
  indexNowEnabled,
  indexNowKey,
  physicianPageUrls,
  servicePageUrls,
} from "./indexnow-core";

describe("physicianPageUrls", () => {
  it("returns the doctor page and the index; trims a trailing slash on base", () => {
    expect(physicianPageUrls("https://drmed.ph/", "dr-jane-cruz")).toEqual([
      "https://drmed.ph/physicians/dr-jane-cruz",
      "https://drmed.ph/physicians",
    ]);
  });
});

describe("servicePageUrls", () => {
  it("lowercases the code and includes the index + packages", () => {
    expect(servicePageUrls("https://drmed.ph", "CBC")).toEqual([
      "https://drmed.ph/all-services/cbc",
      "https://drmed.ph/all-services",
      "https://drmed.ph/packages",
    ]);
  });
});

describe("indexNowKey", () => {
  it("trims stray whitespace so the payload matches the served key file", () => {
    expect(indexNowKey({ INDEXNOW_KEY: "abc123" })).toBe("abc123");
    expect(indexNowKey({ INDEXNOW_KEY: "  abc123  " })).toBe("abc123");
    expect(indexNowKey({ INDEXNOW_KEY: "abc123\n" })).toBe("abc123");
  });
  it("returns null when unset or blank", () => {
    expect(indexNowKey({})).toBeNull();
    expect(indexNowKey({ INDEXNOW_KEY: "" })).toBeNull();
    expect(indexNowKey({ INDEXNOW_KEY: "   " })).toBeNull();
  });
});

describe("indexNowEnabled", () => {
  it("is true only in production with a non-empty key", () => {
    expect(indexNowEnabled({ VERCEL_ENV: "production", INDEXNOW_KEY: "abc" })).toBe(true);
  });
  it("is false without a usable key", () => {
    expect(indexNowEnabled({ VERCEL_ENV: "production", INDEXNOW_KEY: "" })).toBe(false);
    expect(indexNowEnabled({ VERCEL_ENV: "production", INDEXNOW_KEY: "   " })).toBe(false);
    expect(indexNowEnabled({ VERCEL_ENV: "production" })).toBe(false);
  });
  it("is false outside production", () => {
    expect(indexNowEnabled({ VERCEL_ENV: "preview", INDEXNOW_KEY: "abc" })).toBe(false);
    expect(indexNowEnabled({ INDEXNOW_KEY: "abc" })).toBe(false);
  });
});

describe("buildIndexNowPayload", () => {
  const base = { key: "abc", host: "drmed.ph", keyLocation: "https://drmed.ph/indexnow-key.txt" };

  it("dedupes and keeps only same-host http(s) urls", () => {
    const payload = buildIndexNowPayload({
      ...base,
      urls: [
        "https://drmed.ph/physicians",
        "https://drmed.ph/physicians",
        "https://evil.com/x",
        "not-a-url",
        "  ",
      ],
    });
    expect(payload).toEqual({ ...base, urlList: ["https://drmed.ph/physicians"] });
  });

  it("returns null when nothing valid remains", () => {
    expect(buildIndexNowPayload({ ...base, urls: ["https://evil.com/x"] })).toBeNull();
    expect(buildIndexNowPayload({ ...base, urls: [] })).toBeNull();
  });

  it("caps the list at 10000 urls", () => {
    const many = Array.from({ length: 10050 }, (_, i) => `https://drmed.ph/p/${i}`);
    expect(buildIndexNowPayload({ ...base, urls: many })?.urlList.length).toBe(10000);
  });
});
