// Tops up the local fixture so the RLS row-visibility proof is not vacuous.
//
// `rls-equivalence-prove.ts` can only speak for tables that contain rows —
// equivalence over an empty set is trivially true. After the standard seeds
// (`seed:test`, `seed:services`, `seed:physicians`, `seed:hmo`, `seed:templates`,
// `seed:sample-results`) 8 of the 9 Phase 2 tables carry rows; only
// `appointment_attachments` is still empty, because no seed script creates one.
//
// This adds the missing rows, and adds them in DISCRIMINATING pairs: one row the
// probe's patient principal should see and one it should not. A fixture where every
// row is visible to everyone cannot detect a policy that stopped filtering.
//
// Idempotent. Local-only, like every other runner here.
import "../lib/load-env";
import { requireLocalOrExplicitProd } from "../lib/env-guard";
import { Client } from "pg";

requireLocalOrExplicitProd("perf:rls-fixture", {
  writes:
    "inserts appointment_attachments rows on the LOCAL stack so the RLS proof is not vacuous",
});

const DB_URL =
  process.env.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

async function main() {
  const db = new Client({ connectionString: DB_URL });
  await db.connect();

  // The probe picks its patient principal as `patients order by id limit 1`, so
  // seed against the same row or the "visible" case will not line up.
  const { rows: patients } = await db.query<{ id: string }>(
    "select id::text as id from public.patients order by id limit 2",
  );
  if (patients.length === 0) {
    throw new Error("no patients — run `npm run seed:test` first");
  }
  const probePatient = patients[0].id;
  // A second patient if one exists, else NULL: either way this row must NOT be
  // visible to the probe's patient principal.
  const otherPatient = patients[1]?.id ?? null;

  const { rowCount } = await db.query(
    `insert into public.appointment_attachments
       (booking_group_id, patient_id, storage_path, filename, mime_type, size_bytes, kind)
     values
       (gen_random_uuid(), $1::uuid, 'fixture/visible.pdf',  'visible.pdf',  'application/pdf', 1024, 'lab_request'),
       (gen_random_uuid(), $2::uuid, 'fixture/hidden.pdf',   'hidden.pdf',   'application/pdf', 1024, 'lab_request')
     on conflict do nothing`,
    [probePatient, otherPatient],
  );

  const { rows: after } = await db.query<{ n: string }>(
    "select count(*)::text as n from public.appointment_attachments",
  );
  await db.end();

  console.log(
    `appointment_attachments: inserted ${rowCount ?? 0}, now ${after[0].n} rows ` +
      `(one owned by the probe's patient ${probePatient.slice(0, 8)}, one not).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
