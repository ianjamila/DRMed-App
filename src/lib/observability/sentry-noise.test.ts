import { describe, it, expect } from "vitest";
import type { ErrorEvent } from "@sentry/nextjs";
import { isForeignBrowserError } from "./sentry-noise";

function event(value: string, files: string[]): ErrorEvent {
  return {
    type: undefined,
    exception: {
      values: [
        {
          type: "Error",
          value,
          stacktrace: { frames: files.map((filename) => ({ filename })) },
        },
      ],
    },
  };
}

describe("isForeignBrowserError", () => {
  it("drops an error thrown only from an injected script", () => {
    expect(isForeignBrowserError(event("Jsloader error (code #0)", ["app:///injected_script.js"]))).toBe(true);
  });

  it("drops a vendor-tag parse failure that never touches our bundle", () => {
    expect(isForeignBrowserError(event("Invalid or unexpected token", ["app:///0123abcd/script.js"]))).toBe(true);
  });

  it("drops a browser-extension frame", () => {
    expect(isForeignBrowserError(event("boom", ["chrome-extension://abc/content.js"]))).toBe(true);
  });

  it("keeps an error with any first-party frame, even when a vendor threw", () => {
    const e = event("boom", ["app:///0123abcd/script.js", "app:///_next/static/chunks/page.js"]);
    expect(isForeignBrowserError(e)).toBe(false);
  });

  it("keeps a first-party error served from the absolute origin URL", () => {
    expect(isForeignBrowserError(event("boom", ["https://example.test/_next/static/chunks/app.js"]))).toBe(false);
  });

  it("keeps an error with no stack trace — no evidence it is foreign", () => {
    expect(isForeignBrowserError(event("Load failed", []))).toBe(false);
    expect(isForeignBrowserError({ type: undefined, message: "captured message" })).toBe(false);
  });

  it("ignores anonymous/native frames when judging provenance", () => {
    expect(isForeignBrowserError(event("boom", ["<anonymous>", "[native code]"]))).toBe(false);
    expect(isForeignBrowserError(event("boom", ["<anonymous>", "app:///injected.js"]))).toBe(true);
  });

  it("drops the Facebook Android WebView bridge failure despite a first-party wrapper frame", () => {
    const e = event("Error invoking postMessage: Java object is gone", [
      "app:///_next/static/chunks/sentry-wrapper.js",
      "app://navigation_performance_logger_android",
    ]);
    expect(isForeignBrowserError(e)).toBe(true);
  });
});
