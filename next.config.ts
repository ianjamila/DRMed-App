import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

// Content-Security-Policy. Tightened for production; loosened in dev so Next's
// HMR + React Refresh client work. The 'unsafe-inline' allowance for scripts
// is a known compromise — Next.js 16 inlines small bootstrap scripts that
// resist nonce-based replacement. Phase 8 ships strict everywhere else
// (frame-ancestors, form-action, base-uri, object-src) so the residual XSS
// blast radius stays small.
// A local Supabase stack answers on http://127.0.0.1:54321, which
// `https://*.supabase.co` does not cover — so in dev every REST fetch, every
// realtime socket and every storage image was blocked outright, filling the
// console with CSP errors on each page. Derived from the env var rather than
// hardcoded so a non-default `supabase start` port still works, and gated on
// the host actually being loopback so a dev server pointed at the remote
// project (or any prod build) widens nothing.
const localSupabase: { origin: string; ws: string } | null = (() => {
  if (isProd) return null;
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)) {
      return null;
    }
    const scheme = url.protocol === "https:" ? "wss:" : "ws:";
    return { origin: url.origin, ws: `${scheme}//${url.host}` };
  } catch {
    return null;
  }
})();

// `ws:` is only a meaningful source in connect-src, so img-src takes the
// http origin alone rather than a directive full of sources it can't use.
const withLocalSupabase = (
  directive: string,
  ...sources: (keyof NonNullable<typeof localSupabase>)[]
): string =>
  localSupabase
    ? `${directive} ${sources.map((k) => localSupabase[k]).join(" ")}`
    : directive;

const cspDirectives: string[] = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://connect.facebook.net" +
    (isProd ? "" : " 'unsafe-eval'"),
  "style-src 'self' 'unsafe-inline'",
  withLocalSupabase(
    "img-src 'self' data: blob: https://*.supabase.co https://www.facebook.com",
    "origin",
  ),
  "font-src 'self' data:",
  withLocalSupabase(
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.resend.com https://www.facebook.com",
    "origin",
    "ws",
  ),
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  ...(isProd ? ["upgrade-insecure-requests"] : []),
];

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: cspDirectives.join("; "),
  },
  // X-Frame-Options is redundant with CSP frame-ancestors but kept for
  // legacy browsers that don't honour the CSP directive.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Lock down browser features we don't use.
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), accelerometer=(), gyroscope=()",
  },
  // HSTS — only meaningful over HTTPS, which Vercel enforces in prod.
  // Six months + includeSubDomains; preload requires manual submission once
  // the domain has been live for a while.
  ...(isProd
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=15552000; includeSubDomains",
        },
      ]
    : []),
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

const nextConfig: NextConfig = {
  // Next 16 blocks cross-origin requests to /_next/webpack-hmr by default.
  // Playwright sometimes resolves the dev server as 127.0.0.1 even when
  // navigated via localhost (and vice versa), so the HMR websocket fails
  // and React doesn't hydrate. Allowing both here keeps the local dev loop
  // + Playwright MCP smokes working. No effect in production.
  allowedDevOrigins: ["localhost", "127.0.0.1"],
  experimental: {
    // Lab-request-form uploads ride inline in the booking Server Action.
    // Compressed photos are small, but allow headroom for a 5-file submission.
    serverActions: { bodySizeLimit: "20mb" },
  },
  async headers() {
    return [
      {
        // Apply security headers to every route.
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: "drmed",

  project: "sentry-chestnut-cloud",

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  tunnelRoute: "/monitoring",

  webpack: {
    // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
    // See the following for more information:
    // https://docs.sentry.io/product/crons/
    // https://vercel.com/docs/cron-jobs
    automaticVercelMonitors: true,

    // Tree-shaking options for reducing bundle size
    treeshake: {
      // Automatically tree-shake Sentry logger statements to reduce bundle size
      removeDebugLogging: true,
    },
  },
});
