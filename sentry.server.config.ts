// Server-side Sentry init. Loaded by src/instrumentation.ts on Node runtime.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { scrubEvent } from "@/lib/observability/sentry-scrub";

Sentry.init({
  dsn: "https://c3b6e5fb4e82706056249b00e4ba5ccc@o4511346953224192.ingest.us.sentry.io/4511346971705344",

  // Sample 10% of traces in production; full traces in dev/preview to make
  // local debugging easier without paying for it at scale.
  tracesSampleRate: process.env.VERCEL_ENV === "production" ? 0.1 : 1,

  // Don't pipe console.* into Sentry — staff might log PHI while debugging.
  enableLogs: false,

  // RA 10173: do not auto-attach IPs, cookies, headers, request bodies.
  // The scrubEvent hook below additionally redacts DRM-IDs / emails /
  // phones from anything that does pass through.
  sendDefaultPii: false,
  beforeSend: scrubEvent,

  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
});
