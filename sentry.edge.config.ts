// Edge-runtime Sentry init (proxy/middleware, edge route handlers).
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { scrubEvent } from "@/lib/observability/sentry-scrub";

Sentry.init({
  dsn: "https://c3b6e5fb4e82706056249b00e4ba5ccc@o4511346953224192.ingest.us.sentry.io/4511346971705344",

  tracesSampleRate: process.env.VERCEL_ENV === "production" ? 0.1 : 1,
  enableLogs: false,
  sendDefaultPii: false,
  beforeSend: scrubEvent,

  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
});
