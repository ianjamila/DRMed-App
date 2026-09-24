// Client-side Sentry init. Loaded once per browser session.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { scrubEvent } from "@/lib/observability/sentry-scrub";
import { isForeignBrowserError } from "@/lib/observability/sentry-noise";

Sentry.init({
  // Local `next dev` errors belong in the terminal, not the production
  // project (a dev-server curl test once landed there as a new issue).
  enabled: process.env.NODE_ENV !== "development",
  dsn: "https://c3b6e5fb4e82706056249b00e4ba5ccc@o4511346953224192.ingest.us.sentry.io/4511346971705344",

  tracesSampleRate: process.env.NEXT_PUBLIC_VERCEL_ENV === "production" ? 0.1 : 1,
  enableLogs: false,
  sendDefaultPii: false,
  // Drop errors from code we did not ship (extensions, vendor tags, in-app
  // browser bridges) before scrubbing; see sentry-noise.ts.
  beforeSend: (event) => (isForeignBrowserError(event) ? null : scrubEvent(event)),

  // Session Replay deliberately disabled. It captures DOM snapshots, which
  // for a medical app means patient names, results, and PINs would be
  // recorded even with default text masking. Re-enable only behind an
  // explicit flag, scoped to the marketing surface.

  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
