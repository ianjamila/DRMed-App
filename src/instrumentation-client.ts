// Client-side Sentry init. Loaded once per browser session.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { scrubEvent } from "@/lib/observability/sentry-scrub";

Sentry.init({
  dsn: "https://c3b6e5fb4e82706056249b00e4ba5ccc@o4511346953224192.ingest.us.sentry.io/4511346971705344",

  tracesSampleRate: process.env.NEXT_PUBLIC_VERCEL_ENV === "production" ? 0.1 : 1,
  enableLogs: false,
  sendDefaultPii: false,
  beforeSend: scrubEvent,

  // Session Replay deliberately disabled. It captures DOM snapshots, which
  // for a medical app means patient names, results, and PINs would be
  // recorded even with default text masking. Re-enable only behind an
  // explicit flag, scoped to the marketing surface.

  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
