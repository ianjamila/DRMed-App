import { describe, expect, it } from "vitest";
import { relativeSignIn } from "./last-sign-in";

const now = new Date("2026-09-11T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("relativeSignIn", () => {
  it("says Never when the user has never signed in", () => {
    expect(relativeSignIn(null, now)).toBe("Never");
    expect(relativeSignIn(undefined, now)).toBe("Never");
  });

  it("collapses the last minute to Just now", () => {
    expect(relativeSignIn(ago(5_000), now)).toBe("Just now");
  });

  it("reports minutes, then hours", () => {
    expect(relativeSignIn(ago(5 * MIN), now)).toBe("5 min ago");
    expect(relativeSignIn(ago(59 * MIN), now)).toBe("59 min ago");
    expect(relativeSignIn(ago(3 * HOUR), now)).toBe("3 hr ago");
    expect(relativeSignIn(ago(23 * HOUR), now)).toBe("23 hr ago");
  });

  it("names yesterday rather than saying 1 days ago", () => {
    expect(relativeSignIn(ago(DAY + HOUR), now)).toBe("Yesterday");
  });

  it("reports days, then months", () => {
    expect(relativeSignIn(ago(12 * DAY), now)).toBe("12 days ago");
    expect(relativeSignIn(ago(60 * DAY), now)).toBe("2 months ago");
    expect(relativeSignIn(ago(31 * DAY), now)).toBe("1 month ago");
  });

  // A clock skew between the browser, the server and Postgres must not produce
  // "-3 min ago"; a future stamp reads as the present.
  it("treats a future timestamp as Just now", () => {
    expect(relativeSignIn(new Date(now.getTime() + HOUR).toISOString(), now)).toBe(
      "Just now",
    );
  });

  it("returns Never for an unparseable value rather than NaN", () => {
    expect(relativeSignIn("not-a-date", now)).toBe("Never");
  });
});
