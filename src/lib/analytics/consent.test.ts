import { describe, expect, it } from "vitest";
import {
  CONSENT_COOKIE_NAME,
  CONSENT_MAX_AGE_SECONDS,
  hasAdvertisingConsent,
  parseConsentChoice,
  readCookieFromHeader,
} from "./consent";

describe("parseConsentChoice", () => {
  it("accepts the two valid choices", () => {
    expect(parseConsentChoice("granted")).toBe("granted");
    expect(parseConsentChoice("denied")).toBe("denied");
  });

  it("rejects anything else", () => {
    for (const bad of [undefined, null, "", "yes", "true", "1", "GRANTED", "accepted"]) {
      expect(parseConsentChoice(bad)).toBeNull();
    }
  });
});

describe("hasAdvertisingConsent", () => {
  // The core of the opt-in model: only an explicit "granted" tracks. Every
  // other state — never asked, declined, tampered cookie — must not.
  it("is true only for an explicit grant", () => {
    expect(hasAdvertisingConsent("granted")).toBe(true);
  });

  it("is false when no decision has been made", () => {
    expect(hasAdvertisingConsent(undefined)).toBe(false);
    expect(hasAdvertisingConsent(null)).toBe(false);
    expect(hasAdvertisingConsent("")).toBe(false);
  });

  it("is false when consent was declined", () => {
    expect(hasAdvertisingConsent("denied")).toBe(false);
  });

  it("is false for a malformed or tampered value rather than failing open", () => {
    for (const bad of ["true", "1", "GRANTED", "granted ", "{}", "granted;denied"]) {
      expect(hasAdvertisingConsent(bad)).toBe(false);
    }
  });

  it("keeps the consent window at 180 days", () => {
    expect(CONSENT_MAX_AGE_SECONDS).toBe(60 * 60 * 24 * 180);
  });
});

describe("readCookieFromHeader", () => {
  it("returns undefined when the header is absent or empty", () => {
    expect(readCookieFromHeader(undefined, CONSENT_COOKIE_NAME)).toBeUndefined();
    expect(readCookieFromHeader(null, CONSENT_COOKIE_NAME)).toBeUndefined();
    expect(readCookieFromHeader("", CONSENT_COOKIE_NAME)).toBeUndefined();
  });

  it("reads a lone cookie", () => {
    expect(readCookieFromHeader("drmed_cookie_consent=granted", CONSENT_COOKIE_NAME)).toBe(
      "granted",
    );
  });

  it("reads a cookie from the middle of a list, tolerating spacing", () => {
    const header = "_fbp=fb.1.123; drmed_cookie_consent=denied; other=x";
    expect(readCookieFromHeader(header, CONSENT_COOKIE_NAME)).toBe("denied");
  });

  it("returns undefined when the cookie isn't present", () => {
    expect(readCookieFromHeader("_fbp=fb.1.123; other=x", CONSENT_COOKIE_NAME)).toBeUndefined();
  });

  it("does not match on a name that merely contains the target", () => {
    const header = "not_drmed_cookie_consent=granted; drmed_cookie_consent_x=granted";
    expect(readCookieFromHeader(header, CONSENT_COOKIE_NAME)).toBeUndefined();
  });

  it("url-decodes values", () => {
    expect(readCookieFromHeader("x=a%20b", "x")).toBe("a b");
  });

  it("survives a malformed percent-encoding instead of throwing", () => {
    expect(() => readCookieFromHeader("x=%E0%A4%A", "x")).not.toThrow();
    expect(readCookieFromHeader("x=%E0%A4%A", "x")).toBe("%E0%A4%A");
  });

  it("end-to-end: a declined visitor never passes the advertising gate", () => {
    const header = `${CONSENT_COOKIE_NAME}=denied`;
    expect(hasAdvertisingConsent(readCookieFromHeader(header, CONSENT_COOKIE_NAME))).toBe(
      false,
    );
  });
});
