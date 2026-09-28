/**
 * Local-only fixtures for the bulk-select browser checks.
 *
 *   npm run seed:bulk-fixtures                 # (re)load the fixtures
 *   npm run seed:bulk-fixtures -- --as=medtech # …and make inactive@drmed.ph an active medtech
 *
 * Re-runnable: wipes only its own marked rows first (see the SQL file). Refuses
 * any non-local target — --prod / SEED_ALLOW_PROD do not apply. Run
 * `npm run seed:test` first (it creates admin@ and inactive@).
 */
import "./lib/load-env";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { refuseNonLocal, requireLocalOrExplicitProd } from "./lib/env-guard";

const SCRIPT = "seed:bulk-fixtures";
const ROLES = ["reception", "medtech", "xray_technician", "pathologist", "admin"] as const;

requireLocalOrExplicitProd(SCRIPT, {
  writes: "BSQ fixture patients, visits 9101–9106, appointments and website messages; optionally inactive@drmed.ph's role",
});
refuseNonLocal(SCRIPT);

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("SUPABASE_DB_URL is not set — the local stack's is in .env.development.local.");
  process.exit(1);
}
const asArg = process.argv.find((a) => a.startsWith("--as="))?.slice("--as=".length) ?? null;
if (asArg !== null && !(ROLES as readonly string[]).includes(asArg)) {
  console.error(`--as must be one of: ${ROLES.join(", ")}`);
  process.exit(1);
}

const sql = readFileSync(join(__dirname, "seed", "bulk-select-fixtures.sql"), "utf8");
const client = new Client({ connectionString: dbUrl });

async function main() {
  await client.connect();
  try {
    const hmoCount = await client.query("select count(*)::int as n from hmo_providers");
    if (hmoCount.rows[0].n === 0) {
      console.error(`[${SCRIPT}] hmo_providers is empty — run npm run seed:hmo first.`);
      process.exit(1);
    }

    await client.query(sql);
    if (asArg) {
      const r = await client.query(
        "update staff_profiles set is_active = true, role = $1 where id = (select id from auth.users where email = 'inactive@drmed.ph') returning id",
        [asArg],
      );
      if (r.rowCount === 0) throw new Error("inactive@drmed.ph not found — run npm run seed:test first");
      console.log(`inactive@drmed.ph is now an active ${asArg}.`);
    }
    const counts = await client.query(
      `select (select count(*) from visits where visit_number between '9101' and '9106') as visits,
              (select count(*) from test_requests tr join visits v on v.id = tr.visit_id where v.visit_number between '9101' and '9106') as tests,
              (select count(*) from appointments where notes = 'bsq-fixture') as appointments,
              (select count(*) from contact_messages where message like 'bsq-fixture%') as messages`,
    );
    console.log("Bulk-select fixtures loaded:", counts.rows[0]);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
