import { afterEach, describe, expect, it, vi } from "vitest";

// googleAdsConversion runs in the browser, but its guard clauses and the exact
// gtag argument shape (which is what makes the conversion land against the
// right conversion action) are plain logic — exercised here by standing up a
// fake `window`/`document`.
//
// The tag id and the per-conversion labels are read at module scope, because
// `process.env.NEXT_PUBLIC_*` only gets inlined into the client bundle as a
// literal member expression. So each case stubs the env and re-imports the
// module rather than importing it once at the top of the file.

const AW_ID = "AW-868551722";
const BOOKING_LABEL = "abc123BookingLabel";
const MESSENGER_LABEL = "xyz789MessengerLabel";

// Most cases below are about the gtag contract, so they run as a consenting
// visitor. The consent gate itself is covered in its own block.
const GRANTED = "drmed_cookie_consent=granted";

type FakeWindow = { gtag?: unknown };

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

// Fully configured unless a case deliberately blanks something out.
async function loadModule(
  env: { id?: string; booking?: string; messenger?: string } = {},
) {
  const { id = AW_ID, booking = BOOKING_LABEL, messenger = MESSENGER_LABEL } = env;
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_ADS_ID", id);
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_ADS_BOOKING_LABEL", booking);
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_ADS_MESSENGER_LABEL", messenger);
  vi.resetModules();
  return import("./google-ads");
}

afterEach(() => {
  withWindow(undefined);
  withCookie(undefined);
  vi.unstubAllEnvs();
});

describe("googleAdsConversion", () => {
  it("no-ops during SSR (no window)", async () => {
    const { googleAdsConversion } = await loadModule();
    withWindow(undefined);
    expect(() => googleAdsConversion("booking")).not.toThrow();
  });

  it("no-ops when the tag script hasn't loaded (gtag undefined)", async () => {
    const { googleAdsConversion } = await loadModule();
    withWindow({});
    expect(() => googleAdsConversion("booking", "evt-1")).not.toThrow();
  });

  it("no-ops when the tag is disabled and gtag isn't a function", async () => {
    const { googleAdsConversion } = await loadModule();
    withWindow({ gtag: null });
    expect(() => googleAdsConversion("messenger")).not.toThrow();
  });

  it("sends the conversion with the account id and the action's label", async () => {
    const { googleAdsConversion } = await loadModule();
    const gtag = vi.fn();
    withWindow({ gtag });
    withCookie(GRANTED);

    googleAdsConversion("booking");

    expect(gtag).toHaveBeenCalledWith("event", "conversion", {
      send_to: `${AW_ID}/${BOOKING_LABEL}`,
    });
  });

  it("routes each conversion name to its own label", async () => {
    const { googleAdsConversion } = await loadModule();
    const gtag = vi.fn();
    withWindow({ gtag });
    withCookie(GRANTED);

    googleAdsConversion("messenger");

    expect(gtag).toHaveBeenCalledWith("event", "conversion", {
      send_to: `${AW_ID}/${MESSENGER_LABEL}`,
    });
  });

  it("passes transaction_id so Google de-dupes a repeated fire", async () => {
    const { googleAdsConversion } = await loadModule();
    const gtag = vi.fn();
    withWindow({ gtag });
    withCookie(GRANTED);

    googleAdsConversion("booking", "evt-123");

    expect(gtag).toHaveBeenCalledWith("event", "conversion", {
      send_to: `${AW_ID}/${BOOKING_LABEL}`,
      transaction_id: "evt-123",
    });
  });

  it("omits transaction_id entirely when none is given", async () => {
    const { googleAdsConversion } = await loadModule();
    const gtag = vi.fn();
    withWindow({ gtag });
    withCookie(GRANTED);

    googleAdsConversion("booking");

    expect(gtag.mock.calls[0][2]).not.toHaveProperty("transaction_id");
  });

  it("never sends a value or currency — the conversion action owns that", async () => {
    const { googleAdsConversion } = await loadModule();
    const gtag = vi.fn();
    withWindow({ gtag });
    withCookie(GRANTED);

    googleAdsConversion("booking", "evt-1");

    const params = gtag.mock.calls[0][2] as Record<string, unknown>;
    expect(params).not.toHaveProperty("value");
    expect(params).not.toHaveProperty("currency");
    expect(Object.keys(params).sort()).toEqual(["send_to", "transaction_id"]);
  });
});

// Each label is minted separately in the Google Ads UI, so a half-configured
// env is a real state — not a mistake to crash on.
describe("googleAdsConversion configuration gate", () => {
  it("does not fire when the account tag id is unset", async () => {
    const { googleAdsConversion } = await loadModule({ id: "" });
    const gtag = vi.fn();
    withWindow({ gtag });
    withCookie(GRANTED);

    googleAdsConversion("booking");

    expect(gtag).not.toHaveBeenCalled();
  });

  it("does not fire a conversion whose own label is unset", async () => {
    const { googleAdsConversion } = await loadModule({ booking: "" });
    const gtag = vi.fn();
    withWindow({ gtag });
    withCookie(GRANTED);

    googleAdsConversion("booking");

    expect(gtag).not.toHaveBeenCalled();
  });

  it("still fires the conversions whose labels ARE set", async () => {
    const { googleAdsConversion } = await loadModule({ booking: "" });
    const gtag = vi.fn();
    withWindow({ gtag });
    withCookie(GRANTED);

    googleAdsConversion("messenger");

    expect(gtag).toHaveBeenCalledWith("event", "conversion", {
      send_to: `${AW_ID}/${MESSENGER_LABEL}`,
    });
  });
});

// Opt-in consent gate. Normally a declined visitor has no gtag at all because
// <GoogleTag> never mounts the script — these cases cover the defence-in-depth
// path where a gtag exists anyway (browser extension, third-party embed) and
// prove googleAdsConversion still refuses to emit.
describe("googleAdsConversion consent gate", () => {
  it("does not fire when no consent decision has been made", async () => {
    const { googleAdsConversion } = await loadModule();
    const gtag = vi.fn();
    withWindow({ gtag });
    withCookie("");

    googleAdsConversion("booking");

    expect(gtag).not.toHaveBeenCalled();
  });

  it("does not fire when consent was declined", async () => {
    const { googleAdsConversion } = await loadModule();
    const gtag = vi.fn();
    withWindow({ gtag });
    withCookie("drmed_cookie_consent=denied");

    googleAdsConversion("booking", "evt-1");

    expect(gtag).not.toHaveBeenCalled();
  });

  it("does not fire on a tampered consent value", async () => {
    const { googleAdsConversion } = await loadModule();
    const gtag = vi.fn();
    withWindow({ gtag });
    withCookie("drmed_cookie_consent=true");

    googleAdsConversion("messenger");

    expect(gtag).not.toHaveBeenCalled();
  });

  it("does not fire when other cookies exist but consent is absent", async () => {
    const { googleAdsConversion } = await loadModule();
    const gtag = vi.fn();
    withWindow({ gtag });
    withCookie("_gcl_au=1.1.123.456; sb-auth=xyz");

    googleAdsConversion("booking");

    expect(gtag).not.toHaveBeenCalled();
  });

  it("fires once consent is granted", async () => {
    const { googleAdsConversion } = await loadModule();
    const gtag = vi.fn();
    withWindow({ gtag });
    withCookie(`_gcl_au=1.1.123.456; ${GRANTED}`);

    googleAdsConversion("booking");

    expect(gtag).toHaveBeenCalledOnce();
  });

  it("does not throw when document is unavailable", async () => {
    const { googleAdsConversion } = await loadModule();
    const gtag = vi.fn();
    withWindow({ gtag });
    withCookie(undefined);

    expect(() => googleAdsConversion("booking")).not.toThrow();
    expect(gtag).not.toHaveBeenCalled();
  });
});
