-- smoke-clinical-backfill.sql — run against LOCAL supabase only.
--   docker exec -i supabase_db_DRMed psql -U postgres -d postgres < scripts/smoke-clinical-backfill.sql
--
-- Asserts the 0091 GL-silence guards:
--   1. a LEGACY payment insert posts NO journal entry and is NOT blocked by the
--      EOD lock, while recalc_visit_payment still computes payment_status;
--   2. a NON-LEGACY payment still posts exactly one JE.
--
-- Self-contained: creates its own auth.users + staff_profiles fixture (a fresh
-- `supabase db reset` wipes seed-script staff, so we cannot rely on one
-- existing). Everything runs in a transaction that is rolled back at the end.
\set ON_ERROR_STOP on
begin;

-- ---- fixtures --------------------------------------------------------------
-- A staff row for the NOT NULL payments.received_by FK. staff_profiles.id FKs
-- auth.users(id), so create the auth user first.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data, is_super_admin)
values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(),
        'authenticated', 'authenticated', 'smoke-clinical@local.test', 'x',
        now(), now(), now(), '{}', '{}', false)
returning id \gset staff_
insert into public.staff_profiles (id, full_name, role, is_active)
  values (:'staff_id', 'Smoke Clinical Staff', 'admin', true);

insert into public.legacy_import_runs (source, dry_run) values ('smoke', false)
  returning id \gset run_

-- birthdate set so the patients_birthdate_required_for_walkins check passes
-- (real backfilled patients are exempt via legacy_import_run_id instead).
insert into public.patients (drm_id, first_name, last_name, birthdate)
  values ('SMOKE-1', 'Smoke', 'Test', '1990-01-01') returning id \gset pat_

insert into public.visits (patient_id, visit_number, visit_date, payment_status,
                          total_php, paid_php, legacy_import_run_id, legacy_source_ref)
  values (:'pat_id', 'SMOKE-V1', '2024-03-01', 'unpaid', 500, 0,
          :'run_id', 'SMOKE r1')
  returning id \gset vis_

-- NOTE: assertions are written as server-side DO blocks keyed on
-- legacy_source_ref / visit_number. psql does NOT interpolate :vars inside
-- dollar-quoted ($$) blocks, so we must not reference \gset counts there.

-- ---- 1. legacy payment: NO JE, NOT blocked, status recalculated ------------
insert into public.payments (visit_id, amount_php, method, received_by, received_at,
                            legacy_import_run_id, legacy_source_ref)
  values (:'vis_id', 500, 'cash', :'staff_id', '2024-03-01T02:00:00Z',
          :'run_id', 'SMOKE r1 pay');

-- (a) GL-silence: zero JEs reference the legacy payment.
do $$
begin
  if exists (
    select 1 from public.journal_entries je
    where je.source_kind = 'payment'
      and je.source_id in (
        select id from public.payments where legacy_source_ref = 'SMOKE r1 pay'
      )
  ) then
    raise exception 'FAIL: legacy payment posted a journal entry';
  end if;
end $$;

-- (b) recalc_visit_payment stayed live and flipped status to paid.
do $$
declare v_status text;
begin
  select payment_status into v_status
    from public.visits where legacy_source_ref = 'SMOKE r1';
  if v_status is distinct from 'paid' then
    raise exception 'FAIL: recalc did not set payment_status=paid (got %)', v_status;
  end if;
end $$;

-- ---- 2. non-legacy payment: posts exactly one JE ---------------------------
insert into public.visits (patient_id, visit_number, visit_date, payment_status,
                          total_php, paid_php)
  values (:'pat_id', 'SMOKE-V2', current_date, 'unpaid', 100, 0)
  returning id \gset vis2_
insert into public.payments (visit_id, amount_php, method, received_by, received_at)
  values (:'vis2_id', 100, 'cash', :'staff_id', now());

do $$
declare n int;
begin
  select count(*) into n
    from public.journal_entries je
    where je.source_kind = 'payment'
      and je.source_id in (
        select p.id from public.payments p
        join public.visits v on v.id = p.visit_id
        where v.visit_number = 'SMOKE-V2'
      );
  if n <> 1 then
    raise exception 'FAIL: non-legacy payment posted % JE(s), expected 1', n;
  end if;
end $$;

\echo 'SMOKE PASS: legacy GL-silent + recalc live + non-legacy posts 1 JE'
rollback;
