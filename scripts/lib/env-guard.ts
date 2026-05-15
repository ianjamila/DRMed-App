/**
 * Refuse to run against non-local Supabase unless explicitly opted in.
 *
 * Background: the seed scripts read NEXT_PUBLIC_SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY from .env.local. When .env.local is pointed
 * at the linked remote project (the normal state for app dev), running
 * `npm run seed:*` will silently write to production. This guard makes
 * that explicit: by default seeds only run against a local Supabase
 * (URL contains 127.0.0.1 / localhost / supabase_kong); to run against
 * a remote URL the operator must pass --prod or set SEED_ALLOW_PROD=1.
 */
const LOCAL_URL_MARKERS = ["127.0.0.1", "localhost", "supabase_kong"];

function isLocalSupabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  return LOCAL_URL_MARKERS.some((marker) => url.includes(marker));
}

export function requireLocalOrExplicitProd(scriptName: string): void {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const isLocal = isLocalSupabaseUrl(url);
  const allowProd =
    process.env.SEED_ALLOW_PROD === "1" || process.argv.includes("--prod");

  if (!isLocal && !allowProd) {
    const masked = url ? url.replace(/^(https?:\/\/[^/]+).*$/, "$1") : "(unset)";
    console.error(
      [
        ``,
        `[${scriptName}] refusing to run against non-local Supabase.`,
        `  NEXT_PUBLIC_SUPABASE_URL: ${masked}`,
        ``,
        `If this is intentional (e.g. seeding the linked remote project), pass`,
        `--prod or set SEED_ALLOW_PROD=1:`,
        ``,
        `    SEED_ALLOW_PROD=1 npm run ${scriptName}`,
        `    npm run ${scriptName} -- --prod`,
        ``,
        `To run against local Supabase, point NEXT_PUBLIC_SUPABASE_URL at`,
        `your local stack (typically http://127.0.0.1:54321). You can fetch`,
        `it from \`supabase status --output json | jq -r .API_URL\`.`,
        ``,
      ].join("\n"),
    );
    process.exit(1);
  }

  if (!isLocal && allowProd) {
    console.warn(
      `\n[${scriptName}] writing to NON-LOCAL Supabase: ${url}\n`,
    );
  }
}
