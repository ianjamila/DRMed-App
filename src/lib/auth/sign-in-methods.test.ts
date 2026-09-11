import { describe, expect, it } from "vitest";
import { summarizeSignInMethods } from "./sign-in-methods";

describe("summarizeSignInMethods", () => {
  it("reports both routes once a Google identity is linked", () => {
    expect(
      summarizeSignInMethods([
        { provider: "email" },
        { provider: "google" },
      ]),
    ).toEqual({ google: true, password: true });
  });

  it("reports password only for a staff member who has not migrated", () => {
    expect(summarizeSignInMethods([{ provider: "email" }])).toEqual({
      google: false,
      password: true,
    });
  });

  it("reports Google only when there is no password identity", () => {
    expect(summarizeSignInMethods([{ provider: "google" }])).toEqual({
      google: true,
      password: false,
    });
  });

  it("treats no identities as no sign-in route", () => {
    expect(summarizeSignInMethods([])).toEqual({
      google: false,
      password: false,
    });
  });

  // listUsers can omit identities entirely depending on the GoTrue version,
  // and a missing list must not read as "password" — that would show every
  // staff member as already having a working password route.
  it("handles null and undefined", () => {
    expect(summarizeSignInMethods(null)).toEqual({
      google: false,
      password: false,
    });
    expect(summarizeSignInMethods(undefined)).toEqual({
      google: false,
      password: false,
    });
  });

  // A provider we don't model (apple, azure, saml…) must not be guessed at.
  it("ignores providers it does not model", () => {
    expect(summarizeSignInMethods([{ provider: "apple" }])).toEqual({
      google: false,
      password: false,
    });
  });

  it("is idempotent across duplicate identity rows", () => {
    expect(
      summarizeSignInMethods([
        { provider: "google" },
        { provider: "google" },
        { provider: "email" },
      ]),
    ).toEqual({ google: true, password: true });
  });

  it("tolerates a missing provider field", () => {
    expect(
      summarizeSignInMethods([{}, { provider: null }, { provider: "google" }]),
    ).toEqual({ google: true, password: false });
  });
});
