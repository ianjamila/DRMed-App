// Browser-side noise filter for Sentry. Runs before scrubEvent on the client
// only. It drops errors that no change to this codebase can fix, so the
// project's inbox holds real bugs. Two shapes:
//
//   1. Errors thrown entirely from code we did not ship. Our client bundle is
//      always served from /_next/ (turbopack chunks), so a stack trace with no
//      /_next/ frame at all came from something else on the page: a browser
//      extension's injected script (e.g. "Jsloader error … apis.google.com"
//      from an injected tracking_script.js), or a vendor tag such as Vercel
//      Web Analytics' hashed /<id>/script.js that bots fail to decode
//      ("SyntaxError: Invalid or unexpected token" at 1:1). If ANY frame is
//      first-party the event is kept, even when the throw site is a vendor.
//
//   2. Known in-app-browser bridge failures that surface through our
//      listeners. Facebook's Android WebView throws "Error invoking
//      postMessage: Java object is gone" from its own
//      navigation_performance_logger on beforeunload. Sentry's wrapper
//      frame sits in /_next/, so rule 1 cannot see it; match the message.
//
// Events without a stack trace (captured messages, "Load failed" fetch
// errors) are never dropped by rule 1: there is no evidence they are foreign.

import type { ErrorEvent } from "@sentry/nextjs";

const FIRST_PARTY_FRAME = /\/_next\//;

const IGNORED_MESSAGES: RegExp[] = [/Java object is gone/];

function frameFiles(event: ErrorEvent): string[] {
  const files: string[] = [];
  for (const ex of event.exception?.values ?? []) {
    for (const frame of ex.stacktrace?.frames ?? []) {
      const file = frame.abs_path ?? frame.filename;
      // "<anonymous>" / "[native code]" frames say nothing about who threw.
      if (file && !file.startsWith("<") && !file.startsWith("[")) files.push(file);
    }
  }
  return files;
}

export function isForeignBrowserError(event: ErrorEvent): boolean {
  const messages = (event.exception?.values ?? []).map((ex) => ex.value ?? "");
  if (event.message) messages.push(event.message);
  if (messages.some((m) => IGNORED_MESSAGES.some((re) => re.test(m)))) return true;

  const files = frameFiles(event);
  if (files.length === 0) return false;
  return !files.some((f) => FIRST_PARTY_FRAME.test(f));
}
