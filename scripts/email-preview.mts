/**
 * Email preview — renders an owner email to files so you can look at it without
 * sending anything. Read-only: it never sends, never claims a send, never writes an
 * audit row; the only output is two files.
 *
 *   npm run email:preview -- patient-sources                     weekly, LOCAL database
 *   npm run email:preview -- patient-sources --month
 *   npm run email:preview -- patient-sources --today 2026-10-05  as if sent that day
 *   npm run email:preview -- patient-sources --prod --yes        the live numbers (read-only)
 *
 * Writes tmp/email-preview/patient-sources-{week|month}-{from}.html + .txt and prints
 * the paths. A period that starts before Patient Sources' first date prints a message
 * and exits 0. Exit codes: 0 ok / nothing to preview · 1 could not build · 64 bad flags.
 */
import "./lib/load-env";
import { requireLocalOrExplicitProd } from "./lib/env-guard";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT_USAGE, parseEmailPreviewArgs, previewFileBase } from "./lib/email-preview-args";

async function main() {
  // Read-only: still guarded (the report reads real patients' counts), banner says "will read".
  requireLocalOrExplicitProd("email:preview", {
    readOnly: true,
    writes: "nothing in the database — it reads Patient Sources numbers and writes two files under tmp/email-preview/",
  });

  const args = parseEmailPreviewArgs(process.argv.slice(2));
  if (!args.ok) {
    for (const e of args.errors) console.error(e);
    console.error("Usage: email:preview patient-sources [--month] [--today YYYY-MM-DD] [--prod --yes]");
    process.exit(EXIT_USAGE);
  }

  const { todayManilaISODate } = await import("../src/lib/dates/manila");
  const { createClient } = await import("@supabase/supabase-js");
  const { buildPatientSourcesDigestEmail } = await import("../src/lib/marketing/patient-sources-digest.server");

  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const today = args.today ?? todayManilaISODate();
  const built = await buildPatientSourcesDigestEmail(client as never, args.kind, today, process.env.NEXT_PUBLIC_SITE_URL ?? "https://drmed.ph");

  if (!built.ok) {
    console.error(`Could not build the digest: ${built.message}`);
    process.exit(1);
  }
  if (built.kind === "too_early") {
    console.log(`Nothing to preview: the ${args.kind} ending ${built.period.to} starts before Patient Sources' first date (1 December 2023).`);
    process.exit(0);
  }

  const dir = join(process.cwd(), "tmp", "email-preview");
  mkdirSync(dir, { recursive: true });
  const base = join(dir, previewFileBase(args.kind, built.period.from));
  writeFileSync(`${base}.html`, built.html);
  writeFileSync(`${base}.txt`, `${built.subject}\n\n${built.text}\n`);
  console.log(`Subject: ${built.subject}`);
  console.log(`Period:  ${built.period.from} to ${built.period.to} (as if sent ${today})`);
  console.log(`Wrote ${base}.html`);
  console.log(`Wrote ${base}.txt`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
