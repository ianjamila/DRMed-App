import { afterEach, describe, expect, it, vi } from "vitest";
import { metaTrack } from "./meta-pixel";

// metaTrack runs in the browser, but its guard clauses and the exact fbq
// argument shape (which is what makes browser/CAPI de-duplication work) are
// plain logic — exercised here by standing up a fake `window`/`document`.
type FakeWindow = { fbq?: unknown };

function withWindow(win: FakeWindow | undefined) {
  if (win === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = win;
  }
}

function withCookie(cookie: string | undefined) {
  if (cookie === undefined) {
    delete (globalThis as { document?: unknown }).document;
  } else {
    (globalThis as { document?: unknown }).document = { cookie };
  }
}

// Most cases below are about the fbq contract, so they run as a consenting
// visitor. The consent gate itself is covered in its own block.
const GRANTED = "drmed_cookie_consent=granted";

afterEach(() => {
  withWindow(undefined);
  withCookie(undefined);
});

describe("metaTrack", () => {
  it("no-ops during SSR (no window)", () => {
    withWindow(undefined);
    expect(() => metaTrack("PageView")).not.toThrow();
  });

  it("no-ops when the pixel script hasn't loaded (fbq undefined)", () => {
    withWindow({});
    expect(() => metaTrack("Schedule", { content_name: "lab" })).not.toThrow();
  });

  it("no-ops when the pixel is disabled and fbq isn't a function", () => {
    withWindow({ fbq: null });
    expect(() => metaTrack("Contact")).not.toThrow();
  });

  it("forwards the event name and defaults customData to an empty object", () => {
    const fbq = vi.fn();
    withWindow({ fbq });
    withCookie(GRANTED);

    metaTrack("PageView");

    expect(fbq).toHaveBeenCalledWith("track", "PageView", {});
  });

  it("forwards customData when supplied", () => {
    const fbq = vi.fn();
    withWindow({ fbq });
    withCookie(GRANTED);

    metaTrack("Contact", { content_name: "call_click", content_category: "footer" });

    expect(fbq).toHaveBeenCalledWith("track", "Contact", {
      content_name: "call_click",
      content_category: "footer",
    });
  });

  it("passes eventID in the options argument so Meta can de-dupe against CAPI", () => {
    const fbq = vi.fn();
    withWindow({ fbq });
    withCookie(GRANTED);

    metaTrack("Schedule", { content_name: "lab_test" }, "evt-123");

    expect(fbq).toHaveBeenCalledWith(
      "track",
      "Schedule",
      { content_name: "lab_test" },
      { eventID: "evt-123" },
    );
  });

  it("omits the options argument entirely when no eventId is given", () => {
    const fbq = vi.fn();
    withWindow({ fbq });
    withCookie(GRANTED);

    metaTrack("Contact", { content_name: "messenger_fab" });

    expect(fbq.mock.calls[0]).toHaveLength(3);
  });
});

// Opt-in consent gate. Normally a declined visitor has no fbq at all because
// the Pixel script never mounts — these cases cover the defence-in-depth path
// where an fbq exists anyway (browser extension, third-party embed) and prove
// metaTrack still refuses to emit.
describe("metaTrack consent gate", () => {
  it("does not track when no consent decision has been made", () => {
    const fbq = vi.fn();
    withWindow({ fbq });
    withCookie("");

    metaTrack("PageView");

    expect(fbq).not.toHaveBeenCalled();
  });

  it("does not track when consent was declined", () => {
    const fbq = vi.fn();
    withWindow({ fbq });
    withCookie("drmed_cookie_consent=denied");

    metaTrack("Schedule", { content_name: "lab" }, "evt-1");

    expect(fbq).not.toHaveBeenCalled();
  });

  it("does not track on a tampered consent value", () => {
    const fbq = vi.fn();
    withWindow({ fbq });
    withCookie("drmed_cookie_consent=true");

    metaTrack("Contact");

    expect(fbq).not.toHaveBeenCalled();
  });

  it("does not track when other cookies exist but consent is absent", () => {
    const fbq = vi.fn();
    withWindow({ fbq });
    withCookie("_fbp=fb.1.123; sb-auth=xyz");

    metaTrack("Contact");

    expect(fbq).not.toHaveBeenCalled();
  });

  it("tracks once consent is granted", () => {
    const fbq = vi.fn();
    withWindow({ fbq });
    withCookie(`_fbp=fb.1.123; ${GRANTED}`);

    metaTrack("Contact", { content_name: "call_click" });

    expect(fbq).toHaveBeenCalledOnce();
  });

  it("does not throw when document is unavailable", () => {
    const fbq = vi.fn();
    withWindow({ fbq });
    withCookie(undefined);

    expect(() => metaTrack("PageView")).not.toThrow();
    expect(fbq).not.toHaveBeenCalled();
  });
});
