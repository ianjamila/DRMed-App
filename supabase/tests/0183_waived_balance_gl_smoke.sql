-- =============================================================================
-- 0183_waived_balance_gl_smoke.sql
-- =============================================================================
-- LOCAL ONLY. Single-session SQL smoke test for migration 0183 (waive_visit_balance,
-- the per-line allocation, the discount JE, and the P0069/P0070 freeze guards).
-- Run after 0183 is applied:
--   PSQL=/opt/homebrew/opt/libpq/bin/psql
--   $PSQL "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0183_waived_balance_gl_smoke.sql
--
-- Runs inside BEGIN … ROLLBACK and leaves no rows behind. Mints its own staff,
-- patient, services (lab / consult / package), physician and legacy-import
-- run. Cases A–N follow the plan letter-for-letter; each ends with
-- `raise notice 'PASS <letter>'`. Refusals are caught with a nested
-- begin/exception block that re-raises on the wrong sqlstate and fails loudly
-- if the statement did NOT raise at all.
-- =============================================================================

begin;

do $guard$
begin
  if (select count(*) from public.visits where payment_status = 'waived') > 0 then
    raise exception 'refusing: a waived visit already exists — this test assumes none (0183''s own precondition)';
  end if;
end
$guard$;

-- =============================================================================
-- Shared helpers (pg_temp: vanish with the session)
-- =============================================================================

-- Runs sql; returns the SQLSTATE it raised, or 'ok'.
create function pg_temp.state_of(sql text) returns text language plpgsql as $f$
declare s text;
begin
  execute sql;
  return 'ok';
exception when others then
  get stacked diagnostics s = returned_sqlstate;
  return s;
end $f$;

-- Sum of debit_php on one CoA code within one journal entry.
create function pg_temp.dr(v_je uuid, v_code text) returns numeric language sql as $f$
  select coalesce(sum(l.debit_php), 0) from public.journal_lines l
    join public.chart_of_accounts c on c.id = l.account_id
   where l.entry_id = v_je and c.code = v_code;
$f$;

-- Sum of credit_php on one CoA code within one journal entry.
create function pg_temp.cr(v_je uuid, v_code text) returns numeric language sql as $f$
  select coalesce(sum(l.credit_php), 0) from public.journal_lines l
    join public.chart_of_accounts c on c.id = l.account_id
   where l.entry_id = v_je and c.code = v_code;
$f$;

-- "1100 net over the visit's entries": sum(debit) - sum(credit) on code 1100
-- across every journal entry sourced from the visit's lines/payments/waiver
-- allocations, PLUS their reversal descendants, status in ('posted','reversed').
create function pg_temp.ar1100(v_visit uuid) returns numeric language sql as $f$
  with recursive base as (
    select je.id from public.journal_entries je
     where (je.source_kind = 'test_request'
            and je.source_id in (select id from public.test_requests where visit_id = v_visit))
        or (je.source_kind = 'payment'
            and je.source_id in (select id from public.payments where visit_id = v_visit))
        or (je.source_kind = 'visit_waiver'
            and je.source_id in (select id from public.visit_waiver_allocations where visit_id = v_visit))
    union
    select je2.id from public.journal_entries je2 join base b on je2.reverses = b.id
  )
  select coalesce(sum(l.debit_php) - sum(l.credit_php), 0)
    from public.journal_lines l
    join base b on b.id = l.entry_id
    join public.journal_entries je on je.id = b.id
    join public.chart_of_accounts c on c.id = l.account_id and c.code = '1100'
   where je.status in ('posted', 'reversed');
$f$;

-- Close / reopen the accounting period that covers "today" (Manila).
create function pg_temp.close_today() returns void language sql as $f$
  update public.accounting_periods set status = 'closed', closed_at = now()
   where (now() at time zone 'Asia/Manila')::date between period_start and period_end;
$f$;
create function pg_temp.reopen_today() returns void language sql as $f$
  update public.accounting_periods set status = 'open', closed_at = null, closed_by = null
   where (now() at time zone 'Asia/Manila')::date between period_start and period_end;
$f$;

-- 0119 strips PUBLIC EXECUTE from every function postgres creates, temp ones
-- included, so a helper called after `set local role …` needs it re-granted.
do $grant$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p where p.pronamespace = pg_my_temp_schema() loop
    execute format('grant execute on function %s to public', f);
  end loop;
end
$grant$;

-- =============================================================================
-- Shared fixture: admin, medtech, patient, services (lab/consult/package +
-- 8 components), physician, legacy import run. Fixed uuids, referenced by
-- literal in every case below.
--   k_admin        01830000-0000-4000-8000-0000000000a1  admin staff
--   k_medtech      01830000-0000-4000-8000-0000000000a2  medtech staff
--   k_patient      01830000-0000-4000-8000-0000000000a3  patient
--   k_lab_svc      01830000-0000-4000-8000-0000000000b1  ₱500 lab_test
--   k_consult_svc  01830000-0000-4000-8000-0000000000b2  ₱800 doctor_consultation
--   k_physician    01830000-0000-4000-8000-0000000000b3  physician
--   k_pkg_svc      01830000-0000-4000-8000-0000000000b4  ₱5,888 lab_package
--   k_pkg_c1..c8   01830000-0000-4000-8000-0000000000c1..c8  8 component services
--   k_legacy_run   01830000-0000-4000-8000-0000000000d1  legacy_import_runs row
-- =============================================================================
do $setup$
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at)
  values
    ('01830000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-000000000000',
     'authenticated', 'authenticated', 'smoke-0183-admin@example.test', '', now(), now(), now()),
    ('01830000-0000-4000-8000-0000000000a2', '00000000-0000-0000-0000-000000000000',
     'authenticated', 'authenticated', 'smoke-0183-medtech@example.test', '', now(), now(), now());

  insert into public.staff_profiles (id, full_name, role, is_active)
  values
    ('01830000-0000-4000-8000-0000000000a1', 'SMOKE 0183 Admin', 'admin', true),
    ('01830000-0000-4000-8000-0000000000a2', 'SMOKE 0183 Medtech', 'medtech', true);

  insert into public.patients (id, drm_id, first_name, last_name, birthdate)
  values ('01830000-0000-4000-8000-0000000000a3', 'SMOKE-0183', 'Smoke', 'Patient', '1990-01-01');

  insert into public.services (id, code, name, price_php, kind)
  values
    ('01830000-0000-4000-8000-0000000000b1', 'SMK-0183-LAB', 'Smoke lab test', 500, 'lab_test'),
    ('01830000-0000-4000-8000-0000000000b2', 'SMK-0183-CONS', 'Smoke consult', 800, 'doctor_consultation'),
    ('01830000-0000-4000-8000-0000000000b4', 'SMK-0183-PKG', 'Smoke package', 5888, 'lab_package'),
    ('01830000-0000-4000-8000-0000000000c1', 'SMK-0183-PC1', 'Smoke pkg comp 1', 100, 'lab_test'),
    ('01830000-0000-4000-8000-0000000000c2', 'SMK-0183-PC2', 'Smoke pkg comp 2', 100, 'lab_test'),
    ('01830000-0000-4000-8000-0000000000c3', 'SMK-0183-PC3', 'Smoke pkg comp 3', 100, 'lab_test'),
    ('01830000-0000-4000-8000-0000000000c4', 'SMK-0183-PC4', 'Smoke pkg comp 4', 100, 'lab_test'),
    ('01830000-0000-4000-8000-0000000000c5', 'SMK-0183-PC5', 'Smoke pkg comp 5', 100, 'lab_test'),
    ('01830000-0000-4000-8000-0000000000c6', 'SMK-0183-PC6', 'Smoke pkg comp 6', 100, 'lab_test'),
    ('01830000-0000-4000-8000-0000000000c7', 'SMK-0183-PC7', 'Smoke pkg comp 7', 100, 'lab_test'),
    ('01830000-0000-4000-8000-0000000000c8', 'SMK-0183-PC8', 'Smoke pkg comp 8', 100, 'lab_test');

  insert into public.package_components (package_service_id, component_service_id, sort_order)
  values
    ('01830000-0000-4000-8000-0000000000b4', '01830000-0000-4000-8000-0000000000c1', 0),
    ('01830000-0000-4000-8000-0000000000b4', '01830000-0000-4000-8000-0000000000c2', 1),
    ('01830000-0000-4000-8000-0000000000b4', '01830000-0000-4000-8000-0000000000c3', 2),
    ('01830000-0000-4000-8000-0000000000b4', '01830000-0000-4000-8000-0000000000c4', 3),
    ('01830000-0000-4000-8000-0000000000b4', '01830000-0000-4000-8000-0000000000c5', 4),
    ('01830000-0000-4000-8000-0000000000b4', '01830000-0000-4000-8000-0000000000c6', 5),
    ('01830000-0000-4000-8000-0000000000b4', '01830000-0000-4000-8000-0000000000c7', 6),
    ('01830000-0000-4000-8000-0000000000b4', '01830000-0000-4000-8000-0000000000c8', 7);

  insert into public.physicians (id, slug, full_name, specialty)
  values ('01830000-0000-4000-8000-0000000000b3', 'smoke-0183-dr', 'Dr Smoke 0183', 'General Medicine');

  insert into public.legacy_import_runs (id, source, dry_run, run_by)
  values ('01830000-0000-4000-8000-0000000000d1', 'smoke-0183', false, '01830000-0000-4000-8000-0000000000a1');
end
$setup$;

-- =============================================================================
-- A — Guards vs a NON-ADMIN staff JWT [CR-2]
-- =============================================================================
do $A$
declare
  k_admin   constant uuid := '01830000-0000-4000-8000-0000000000a1';
  k_medtech constant uuid := '01830000-0000-4000-8000-0000000000a2';
  k_patient constant uuid := '01830000-0000-4000-8000-0000000000a3';
  v_unpaid uuid;
  v_waived uuid;
  v_n      int;
  v_state  text;
begin
  insert into public.visits (patient_id, total_php, paid_php, payment_status)
  values (k_patient, 500, 0, 'unpaid') returning id into v_unpaid;

  insert into public.visits (patient_id, total_php, paid_php, payment_status)
  values (k_patient, 500, 0, 'unpaid') returning id into v_waived;
  set local session_replication_role = replica;
  update public.visits
     set payment_status = 'waived', waived_php = 500, waived_at = now(),
         waived_by = k_admin, waive_reason = 'A fixture'
   where id = v_waived;
  set local session_replication_role = origin;

  set local role authenticated;
  perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', k_medtech), true);

  -- The row must be visible under this JWT — RLS "visits: staff full" covers
  -- every staff role, so a 0-row match below would mean the assertions after
  -- it are meaningless (see the task note).
  select count(*) into v_n from public.visits where id in (v_unpaid, v_waived);
  if v_n <> 2 then
    raise exception 'A SETUP FAIL: medtech JWT cannot see the fixture visits (RLS?), got % rows', v_n;
  end if;

  -- 1. insert a visit already 'waived'
  begin
    insert into public.visits (patient_id, total_php, payment_status) values (k_patient, 100, 'waived');
    raise exception 'A FAIL: insert of a waived visit by non-admin was accepted';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> 'P0069' then raise; end if;
  end;

  -- 2. unpaid -> waived
  begin
    update public.visits set payment_status = 'waived' where id = v_unpaid;
    raise exception 'A FAIL: unpaid -> waived by non-admin was accepted';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> 'P0069' then raise; end if;
  end;

  -- 3. waived -> unpaid
  begin
    update public.visits set payment_status = 'unpaid' where id = v_waived;
    raise exception 'A FAIL: un-waive was accepted';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> 'P0069' then raise; end if;
  end;

  -- 4. total_php on a waived visit
  begin
    update public.visits set total_php = 999 where id = v_waived;
    raise exception 'A FAIL: total_php change on a waived visit was accepted';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> 'P0069' then raise; end if;
  end;

  -- 5. paid_php on a waived visit [CR-14]
  begin
    update public.visits set paid_php = 999 where id = v_waived;
    raise exception 'A FAIL: paid_php change on a waived visit was accepted';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> 'P0069' then raise; end if;
  end;

  perform set_config('request.jwt.claims', '', true);
  reset role;
  raise notice 'PASS A';
end
$A$;

-- =============================================================================
-- B / C / C2 — the core split + fold + undo + cancel narrative
-- =============================================================================
do $BCC2$
declare
  k_admin       constant uuid := '01830000-0000-4000-8000-0000000000a1';
  k_patient     constant uuid := '01830000-0000-4000-8000-0000000000a3';
  k_lab_svc     constant uuid := '01830000-0000-4000-8000-0000000000b1';
  k_consult_svc constant uuid := '01830000-0000-4000-8000-0000000000b2';
  k_physician   constant uuid := '01830000-0000-4000-8000-0000000000b3';
  v_visit  uuid;
  v_lab    uuid;
  v_cons   uuid;
  v_pay    uuid;
  v_res    jsonb;
  v_amt    numeric;
  v_acct   text;
  v_rec    timestamptz;
  v_jeid   uuid;
  v_je_lab  uuid;
  v_je_cons uuid;
  v_je_lab2 uuid;
  v_je_rev  uuid;
  v_sum    numeric;
  v_net    numeric;
  v_n      int;
begin
  insert into public.visits (patient_id, total_php, paid_php, payment_status)
  values (k_patient, 1300, 0, 'unpaid') returning id into v_visit;

  insert into public.test_requests (visit_id, service_id, status, requested_by,
                                    base_price_php, final_price_php)
  values (v_visit, k_lab_svc, 'ready_for_release', k_admin, 500, 500)
  returning id into v_lab;

  insert into public.test_requests (visit_id, service_id, status, requested_by,
                                    final_price_php, clinic_fee_php, doctor_pf_php,
                                    attending_physician_id)
  values (v_visit, k_consult_svc, 'ready_for_release', k_admin, 800, 300, 500, k_physician)
  returning id into v_cons;

  insert into public.payments (visit_id, amount_php, method, received_by)
  values (v_visit, 300, 'cash', k_admin) returning id into v_pay;

  perform 1 from public.visits where id = v_visit and payment_status = 'partial' and paid_php = 300;
  if not found then raise exception 'B SETUP FAIL: expected partial/300 before waive'; end if;

  v_res := public.waive_visit_balance(v_visit, k_admin, 'B smoke: lab + consult');

  perform 1 from public.visits
   where id = v_visit and payment_status = 'waived' and waived_php = 1000 and paid_php = 300;
  if not found then raise exception 'B FAIL: visit fields after waive'; end if;

  select amount_php, discount_account, recognised_at into v_amt, v_acct, v_rec
    from public.visit_waiver_allocations where test_request_id = v_lab;
  if v_amt <> 384.62 or v_acct <> '4910' or v_rec is not null then
    raise exception 'B FAIL: lab allocation amount=% account=% recognised_at=%', v_amt, v_acct, v_rec;
  end if;

  select amount_php, discount_account, recognised_at into v_amt, v_acct, v_rec
    from public.visit_waiver_allocations where test_request_id = v_cons;
  if v_amt <> 615.38 or v_acct <> '4920' or v_rec is not null then
    raise exception 'B FAIL: consult allocation amount=% account=% recognised_at=%', v_amt, v_acct, v_rec;
  end if;

  select sum(amount_php) into v_sum from public.visit_waiver_allocations where visit_id = v_visit;
  if v_sum <> 1000 then raise exception 'B FAIL: allocations sum to %, want 1000', v_sum; end if;

  if exists (select 1 from public.journal_entries where source_kind = 'visit_waiver'
             and source_id in (select id from public.visit_waiver_allocations where visit_id = v_visit)) then
    raise exception 'B FAIL: a standalone visit_waiver JE exists before any release';
  end if;

  -- Release the lab line: DR 1100 115.38, DR 4910 384.62, CR 4100 500.
  update public.test_requests
     set status = 'released', released_at = now(), released_by = k_admin, release_medium = 'physical'
   where id = v_lab;
  select id into v_je_lab from public.journal_entries
   where source_kind = 'test_request' and source_id = v_lab and status = 'posted';
  if v_je_lab is null then raise exception 'B FAIL: no release JE for the lab line'; end if;
  if pg_temp.dr(v_je_lab, '1100') <> 115.38 or pg_temp.dr(v_je_lab, '4910') <> 384.62
     or pg_temp.cr(v_je_lab, '4100') <> 500 then
    raise exception 'B FAIL: lab release JE amounts wrong (1100 dr=%, 4910 dr=%, 4100 cr=%)',
      pg_temp.dr(v_je_lab, '1100'), pg_temp.dr(v_je_lab, '4910'), pg_temp.cr(v_je_lab, '4100');
  end if;
  select recognised_at, journal_entry_id into v_rec, v_jeid
    from public.visit_waiver_allocations where test_request_id = v_lab;
  if v_rec is null or v_jeid <> v_je_lab then
    raise exception 'B FAIL: lab allocation not recognised against its release JE';
  end if;

  -- Release the consult line: DR 1100 184.62, DR 4920 615.38, CR 4200 300, CR 2110 500.
  update public.test_requests
     set status = 'released', released_at = now(), released_by = k_admin, release_medium = 'physical'
   where id = v_cons;
  select id into v_je_cons from public.journal_entries
   where source_kind = 'test_request' and source_id = v_cons and status = 'posted';
  if v_je_cons is null then raise exception 'B FAIL: no release JE for the consult line'; end if;
  if pg_temp.dr(v_je_cons, '1100') <> 184.62 or pg_temp.dr(v_je_cons, '4920') <> 615.38
     or pg_temp.cr(v_je_cons, '4200') <> 300 or pg_temp.cr(v_je_cons, '2110') <> 500 then
    raise exception 'B FAIL: consult release JE amounts wrong (1100 dr=%, 4920 dr=%, 4200 cr=%, 2110 cr=%)',
      pg_temp.dr(v_je_cons, '1100'), pg_temp.dr(v_je_cons, '4920'),
      pg_temp.cr(v_je_cons, '4200'), pg_temp.cr(v_je_cons, '2110');
  end if;
  select recognised_at, journal_entry_id into v_rec, v_jeid
    from public.visit_waiver_allocations where test_request_id = v_cons;
  if v_rec is null or v_jeid <> v_je_cons then
    raise exception 'B FAIL: consult allocation not recognised against its release JE';
  end if;

  v_net := pg_temp.ar1100(v_visit);
  if v_net <> 0 then raise exception 'B FAIL: 1100 net = %, want 0', v_net; end if;
  raise notice 'PASS B';

  -- ---- C: undo-release the lab line; re-release folds again ----------------
  update public.test_requests
     set status = 'ready_for_release', released_at = null, released_by = null, release_medium = null
   where id = v_lab;

  if (select status from public.journal_entries where id = v_je_lab) <> 'reversed' then
    raise exception 'C FAIL: original lab release JE not marked reversed';
  end if;
  if not exists (select 1 from public.journal_entries where reverses = v_je_lab and status = 'posted') then
    raise exception 'C FAIL: no mirrored posted reversal of the lab release JE';
  end if;
  select recognised_at, journal_entry_id into v_rec, v_jeid
    from public.visit_waiver_allocations where test_request_id = v_lab;
  if v_rec is not null or v_jeid is not null then
    raise exception 'C FAIL: lab allocation still recognised after undo-release';
  end if;

  -- re-release: folds again into a fresh JE.
  update public.test_requests
     set status = 'released', released_at = now(), released_by = k_admin, release_medium = 'physical'
   where id = v_lab;
  select id into v_je_lab2 from public.journal_entries
   where source_kind = 'test_request' and source_id = v_lab and status = 'posted';
  if v_je_lab2 is null or v_je_lab2 = v_je_lab then
    raise exception 'C FAIL: re-release did not produce a fresh posted JE';
  end if;
  if pg_temp.dr(v_je_lab2, '1100') <> 115.38 or pg_temp.dr(v_je_lab2, '4910') <> 384.62 then
    raise exception 'C FAIL: re-release JE amounts wrong (1100 dr=%, 4910 dr=%)',
      pg_temp.dr(v_je_lab2, '1100'), pg_temp.dr(v_je_lab2, '4910');
  end if;
  select recognised_at, journal_entry_id into v_rec, v_jeid
    from public.visit_waiver_allocations where test_request_id = v_lab;
  if v_rec is null or v_jeid <> v_je_lab2 then
    raise exception 'C FAIL: lab allocation not recognised against the re-release JE';
  end if;

  v_net := pg_temp.ar1100(v_visit);
  if v_net <> 0 then raise exception 'C FAIL: 1100 net = %, want 0 (unchanged)', v_net; end if;
  raise notice 'PASS C';

  -- ---- C2: cancel the consult (released -> cancelled) -----------------------
  update public.test_requests set status = 'cancelled' where id = v_cons;

  if (select status from public.journal_entries where id = v_je_cons) <> 'reversed' then
    raise exception 'C2 FAIL: consult release JE not marked reversed';
  end if;
  select id into v_je_rev from public.journal_entries where reverses = v_je_cons and status = 'posted';
  if v_je_rev is null then raise exception 'C2 FAIL: no mirrored posted reversal of the consult release JE'; end if;
  if exists (select 1 from public.journal_entries where source_kind = 'visit_waiver'
             and source_id in (select id from public.visit_waiver_allocations where test_request_id = v_cons)) then
    raise exception 'C2 FAIL: a standalone visit_waiver JE exists for the consult (should never have one)';
  end if;
  select recognised_at, journal_entry_id into v_rec, v_jeid
    from public.visit_waiver_allocations where test_request_id = v_cons;
  if v_rec is not null or v_jeid is not null then
    raise exception 'C2 FAIL: consult allocation still recognised after cancel';
  end if;

  -- 1100 net for just the consult's own two entries (release + reversal) = 0.
  if (pg_temp.dr(v_je_cons, '1100') - pg_temp.cr(v_je_cons, '1100')
      + pg_temp.dr(v_je_rev, '1100') - pg_temp.cr(v_je_rev, '1100')) <> 0 then
    raise exception 'C2 FAIL: 1100 net for the consult''s own entries is not 0';
  end if;
  raise notice 'PASS C2';

  -- =============================================================================
  -- E — P0070 on the (still-waived) visit B, plus the P0004 precedence case
  -- =============================================================================
  declare
    v_other_visit uuid;
    v_other_pay   uuid;
    v_state       text;
    v_new_id      uuid;
    v_row         public.payments%rowtype;
  begin
    insert into public.visits (patient_id, total_php, paid_php, payment_status)
    values (k_patient, 500, 0, 'unpaid') returning id into v_other_visit;

    -- 1. insert a payment on B
    begin
      insert into public.payments (visit_id, amount_php, method, received_by) values (v_visit, 50, 'cash', k_admin);
      raise exception 'E FAIL: payment insert on a waived visit was accepted';
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate; if v_state <> 'P0070' then raise; end if;
    end;

    -- 2. void the 300 payment
    begin
      update public.payments set voided_at = now(), voided_by = k_admin, void_reason = 'x' where id = v_pay;
      raise exception 'E FAIL: void on a waived visit was accepted';
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate; if v_state <> 'P0070' then raise; end if;
    end;

    -- 3. hard delete: the bridge reverses the JE first, then the guard raises;
    -- nothing must commit.
    begin
      delete from public.payments where id = v_pay;
      raise exception 'E FAIL: hard delete on a waived visit was accepted';
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate; if v_state <> 'P0070' then raise; end if;
    end;
    if not exists (select 1 from public.payments where id = v_pay) then
      raise exception 'E FAIL: the payment row is gone after a refused delete';
    end if;
    if (select status from public.journal_entries where source_kind = 'payment' and source_id = v_pay) <> 'posted' then
      raise exception 'E FAIL: the payment''s JE was left reversed after a refused delete';
    end if;

    -- 4. correct_payment: a different amount
    begin
      perform public.correct_payment(v_pay, 350, 'cash', null, null, 'amt change', k_admin);
      raise exception 'E FAIL: correct_payment amount change on a waived visit was accepted';
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate; if v_state <> 'P0070' then raise; end if;
    end;

    -- 5. correct_payment: move B's payment off
    begin
      perform public.correct_payment(v_pay, 300, 'cash', null, null, 'move off', k_admin, v_other_visit);
      raise exception 'E FAIL: correct_payment move off a waived visit was accepted';
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate; if v_state <> 'P0070' then raise; end if;
    end;

    -- 6. correct_payment: move an unpaid visit's payment ONTO B
    insert into public.payments (visit_id, amount_php, method, received_by)
    values (v_other_visit, 100, 'cash', k_admin) returning id into v_other_pay;
    begin
      perform public.correct_payment(v_other_pay, 100, 'cash', null, null, 'move onto waived', k_admin, v_visit);
      raise exception 'E FAIL: correct_payment move onto a waived visit was accepted';
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate; if v_state <> 'P0070' then raise; end if;
    end;

    -- 7. direct updates on B's POSTED payment: P0004 (0030) sorts first, still
    -- refused. NOTE: P0004 collides with Postgres's own reserved SQLSTATE for
    -- assert_failure, which `WHEN OTHERS` explicitly does NOT catch (per the
    -- PL/pgSQL docs) — verified empirically here; catch it by name instead.
    begin
      update public.payments set amount_php = 250 where id = v_pay;
      raise exception 'E FAIL: direct amount_php update on a JE''d payment was accepted';
    exception when assert_failure then
      get stacked diagnostics v_state = returned_sqlstate; if v_state <> 'P0004' then raise; end if;
    end;
    begin
      update public.payments set visit_id = v_other_visit where id = v_pay;
      raise exception 'E FAIL: direct visit_id update on a JE''d payment was accepted';
    exception when assert_failure then
      get stacked diagnostics v_state = returned_sqlstate; if v_state <> 'P0004' then raise; end if;
    end;

    -- 8. correct_payment: same amount, method cash -> gcash. OK.
    v_new_id := public.correct_payment(v_pay, 300, 'gcash', null, null, 'was gcash', k_admin);
    if v_new_id = v_pay then raise exception 'E FAIL: method-only edit did not re-create the row'; end if;
    select * into v_row from public.payments where id = v_pay;
    if v_row.voided_at is null or v_row.void_reason not like 'Edited: %' then
      raise exception 'E FAIL: original payment not voided with an Edited: reason (void_reason=%)', v_row.void_reason;
    end if;
    perform 1 from public.visits where id = v_visit and payment_status = 'waived' and paid_php = 300;
    if not found then raise exception 'E FAIL: visit not still waived/300 after the equal-amount edit'; end if;

    raise notice 'PASS E';
  end;
end
$BCC2$;

-- =============================================================================
-- D — an already-released line at waive time (standalone JE), undo and cancel
-- =============================================================================
do $D$
declare
  k_admin   constant uuid := '01830000-0000-4000-8000-0000000000a1';
  k_patient constant uuid := '01830000-0000-4000-8000-0000000000a3';
  k_lab_svc constant uuid := '01830000-0000-4000-8000-0000000000b1';
  v_visit uuid;
  v_line  uuid;
  v_pay   uuid;
  v_je_release uuid;
  v_je_waiver  uuid;
  v_rec   timestamptz;
  v_jeid  uuid;
begin
  -- ---- D1: undo path ---------------------------------------------------------
  insert into public.visits (patient_id, total_php, paid_php, payment_status)
  values (k_patient, 500, 0, 'unpaid') returning id into v_visit;
  insert into public.test_requests (visit_id, service_id, status, requested_by, base_price_php, final_price_php)
  values (v_visit, k_lab_svc, 'ready_for_release', k_admin, 500, 500) returning id into v_line;
  insert into public.payments (visit_id, amount_php, method, received_by) values (v_visit, 500, 'cash', k_admin)
  returning id into v_pay;
  perform 1 from public.visits where id = v_visit and payment_status = 'paid';
  if not found then raise exception 'D SETUP FAIL: expected paid before release'; end if;

  update public.test_requests
     set status = 'released', released_at = now(), released_by = k_admin, release_medium = 'physical'
   where id = v_line;
  select id into v_je_release from public.journal_entries
   where source_kind = 'test_request' and source_id = v_line and status = 'posted';

  -- Void is allowed pre-waive.
  update public.payments set voided_at = now(), voided_by = k_admin, void_reason = 'pre-waive void' where id = v_pay;
  perform 1 from public.visits where id = v_visit and payment_status = 'unpaid' and paid_php = 0;
  if not found then raise exception 'D SETUP FAIL: expected unpaid/0 after void'; end if;

  perform public.waive_visit_balance(v_visit, k_admin, 'D1 smoke: already released');

  select journal_entry_id, recognised_at into v_jeid, v_rec
    from public.visit_waiver_allocations where test_request_id = v_line;
  if v_rec is null or v_jeid is null then raise exception 'D FAIL: allocation not recognised at waive time'; end if;
  v_je_waiver := v_jeid;
  if (select source_kind from public.journal_entries where id = v_je_waiver) <> 'visit_waiver' then
    raise exception 'D FAIL: the posted JE is not a standalone visit_waiver entry';
  end if;
  if pg_temp.dr(v_je_waiver, '4910') <> 500 or pg_temp.cr(v_je_waiver, '1100') <> 500 then
    raise exception 'D FAIL: waiver JE amounts wrong (4910 dr=%, 1100 cr=%)',
      pg_temp.dr(v_je_waiver, '4910'), pg_temp.cr(v_je_waiver, '1100');
  end if;

  -- Undo-release: the standalone waiver JE is reversed (pair), allocation unrecognised.
  update public.test_requests
     set status = 'ready_for_release', released_at = null, released_by = null, release_medium = null
   where id = v_line;
  if (select status from public.journal_entries where id = v_je_waiver) <> 'reversed' then
    raise exception 'D1 FAIL: standalone waiver JE not reversed after undo-release';
  end if;
  if not exists (select 1 from public.journal_entries where reverses = v_je_waiver and status = 'posted') then
    raise exception 'D1 FAIL: no mirrored posted reversal of the waiver JE';
  end if;
  select recognised_at, journal_entry_id into v_rec, v_jeid
    from public.visit_waiver_allocations where test_request_id = v_line;
  if v_rec is not null or v_jeid is not null then
    raise exception 'D1 FAIL: allocation still recognised after undo-release';
  end if;
  raise notice 'PASS D1';

  -- ---- D2: cancel path (a second visit) --------------------------------------
  declare
    v_visit2 uuid;
    v_line2  uuid;
    v_pay2   uuid;
    v_je_waiver2 uuid;
  begin
    insert into public.visits (patient_id, total_php, paid_php, payment_status)
    values (k_patient, 500, 0, 'unpaid') returning id into v_visit2;
    insert into public.test_requests (visit_id, service_id, status, requested_by, base_price_php, final_price_php)
    values (v_visit2, k_lab_svc, 'ready_for_release', k_admin, 500, 500) returning id into v_line2;
    insert into public.payments (visit_id, amount_php, method, received_by) values (v_visit2, 500, 'cash', k_admin)
    returning id into v_pay2;

    update public.test_requests
       set status = 'released', released_at = now(), released_by = k_admin, release_medium = 'physical'
     where id = v_line2;
    update public.payments set voided_at = now(), voided_by = k_admin, void_reason = 'pre-waive void' where id = v_pay2;

    perform public.waive_visit_balance(v_visit2, k_admin, 'D2 smoke: already released, cancel path');

    select journal_entry_id into v_je_waiver2 from public.visit_waiver_allocations where test_request_id = v_line2;
    if v_je_waiver2 is null then raise exception 'D2 FAIL: allocation not recognised at waive time'; end if;

    update public.test_requests set status = 'cancelled' where id = v_line2;
    if (select status from public.journal_entries where id = v_je_waiver2) <> 'reversed' then
      raise exception 'D2 FAIL: standalone waiver JE not reversed after cancel';
    end if;
    if not exists (select 1 from public.journal_entries where reverses = v_je_waiver2 and status = 'posted') then
      raise exception 'D2 FAIL: no mirrored posted reversal of the waiver JE';
    end if;
    select recognised_at, journal_entry_id into v_rec, v_jeid
      from public.visit_waiver_allocations where test_request_id = v_line2;
    if v_rec is not null or v_jeid is not null then
      raise exception 'D2 FAIL: allocation still recognised after cancel';
    end if;
    raise notice 'PASS D2';
  end;

  raise notice 'PASS D';
end
$D$;

-- =============================================================================
-- F — provenance: all-imported waives silently; mixed refuses; frozen fields
-- =============================================================================
do $F$
declare
  k_admin      constant uuid := '01830000-0000-4000-8000-0000000000a1';
  k_patient    constant uuid := '01830000-0000-4000-8000-0000000000a3';
  k_lab_svc    constant uuid := '01830000-0000-4000-8000-0000000000b1';
  k_legacy_run constant uuid := '01830000-0000-4000-8000-0000000000d1';
  v_visit uuid;
  v_line  uuid;
  v_pay   uuid;
  v_state text;
  v_n     int;
begin
  -- ---- F1: all-imported --------------------------------------------------
  insert into public.visits (patient_id, total_php, paid_php, payment_status, legacy_import_run_id)
  values (k_patient, 500, 0, 'unpaid', k_legacy_run) returning id into v_visit;
  insert into public.test_requests (visit_id, service_id, status, requested_by, final_price_php, legacy_import_run_id)
  values (v_visit, k_lab_svc, 'released', k_admin, 500, k_legacy_run) returning id into v_line;
  insert into public.payments (visit_id, amount_php, method, received_by, legacy_import_run_id)
  values (v_visit, 200, 'cash', k_admin, k_legacy_run) returning id into v_pay;

  perform public.waive_visit_balance(v_visit, k_admin, 'F1 smoke: all imported');

  perform 1 from public.visits where id = v_visit and payment_status = 'waived' and waived_php = 300;
  if not found then raise exception 'F1 FAIL: waived_php should be 300'; end if;
  select count(*) into v_n from public.visit_waiver_allocations where visit_id = v_visit;
  if v_n <> 0 then raise exception 'F1 FAIL: expected 0 allocations, got %', v_n; end if;
  if exists (select 1 from public.journal_entries
             where (source_kind = 'test_request' and source_id = v_line)
                or (source_kind = 'payment' and source_id = v_pay)) then
    raise exception 'F1 FAIL: expected 0 JEs for an all-imported waive';
  end if;
  raise notice 'PASS F1';

  -- Frozen fields on the now-waived imported visit.
  begin
    update public.payments set amount_php = 999 where id = v_pay;
    raise exception 'F FAIL: amount edit on a JE-less legacy payment was accepted';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate; if v_state <> 'P0070' then raise; end if;
  end;
  begin
    update public.payments set legacy_import_run_id = null where id = v_pay;
    raise exception 'F FAIL: clearing payment provenance on a waived visit was accepted';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate; if v_state <> 'P0070' then raise; end if;
  end;
  begin
    update public.test_requests set legacy_import_run_id = null where id = v_line;
    raise exception 'F FAIL: clearing line provenance on a waived visit was accepted';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate; if v_state <> 'P0070' then raise; end if;
  end;
  raise notice 'PASS F2';

  -- ---- F3: mixed (imported visit, live line) -> P0071 ----------------------
  declare
    v_mix uuid;
  begin
    insert into public.visits (patient_id, total_php, paid_php, payment_status, legacy_import_run_id)
    values (k_patient, 500, 0, 'unpaid', k_legacy_run) returning id into v_mix;
    insert into public.test_requests (visit_id, service_id, status, requested_by, final_price_php)
    values (v_mix, k_lab_svc, 'ready_for_release', k_admin, 500);
    begin
      perform public.waive_visit_balance(v_mix, k_admin, 'F3 smoke: mixed');
      raise exception 'F3 FAIL: a mixed-provenance visit was allowed to waive';
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate; if v_state <> 'P0071' then raise; end if;
    end;
    raise notice 'PASS F3';
  end;

  raise notice 'PASS F';
end
$F$;

-- =============================================================================
-- G — refusals: HMO, paid, non-admin actor, blank reason, already waived
-- =============================================================================
do $G$
declare
  k_admin   constant uuid := '01830000-0000-4000-8000-0000000000a1';
  k_medtech constant uuid := '01830000-0000-4000-8000-0000000000a2';
  k_patient constant uuid := '01830000-0000-4000-8000-0000000000a3';
  v_hmo     uuid;
  v_visit   uuid;
  v_state   text;
begin
  insert into public.hmo_providers (name) values ('SMOKE 0183 HMO') returning id into v_hmo;

  -- 1. HMO visit
  insert into public.visits (patient_id, total_php, payment_status, hmo_provider_id)
  values (k_patient, 500, 'unpaid', v_hmo) returning id into v_visit;
  begin
    perform public.waive_visit_balance(v_visit, k_admin, 'reason');
    raise exception 'G FAIL: an HMO visit was allowed to waive';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate; if v_state <> 'P0071' then raise; end if;
  end;

  -- 2. paid visit
  insert into public.visits (patient_id, total_php, paid_php, payment_status)
  values (k_patient, 500, 500, 'paid') returning id into v_visit;
  begin
    perform public.waive_visit_balance(v_visit, k_admin, 'reason');
    raise exception 'G FAIL: a fully-paid visit was allowed to waive';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate; if v_state <> 'P0071' then raise; end if;
  end;

  -- 3. non-admin actor
  insert into public.visits (patient_id, total_php, payment_status)
  values (k_patient, 100, 'unpaid') returning id into v_visit;
  begin
    perform public.waive_visit_balance(v_visit, k_medtech, 'reason');
    raise exception 'G FAIL: a non-admin actor was allowed to waive';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate; if v_state <> 'P0071' then raise; end if;
  end;

  -- 4. blank reason
  begin
    perform public.waive_visit_balance(v_visit, k_admin, '   ');
    raise exception 'G FAIL: a blank reason was allowed';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate; if v_state <> 'P0071' then raise; end if;
  end;

  -- 5. already waived
  set local session_replication_role = replica;
  update public.visits
     set payment_status = 'waived', waived_php = 100, waived_at = now(), waived_by = k_admin, waive_reason = 'x'
   where id = v_visit;
  set local session_replication_role = origin;
  begin
    perform public.waive_visit_balance(v_visit, k_admin, 'reason');
    raise exception 'G FAIL: an already-waived visit was allowed to waive again';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate; if v_state <> 'P0071' then raise; end if;
  end;

  raise notice 'PASS G';
end
$G$;

-- =============================================================================
-- H — largest remainder in centavos; a package visit allocates to the header only
-- =============================================================================
do $H$
declare
  k_admin   constant uuid := '01830000-0000-4000-8000-0000000000a1';
  k_patient constant uuid := '01830000-0000-4000-8000-0000000000a3';
  k_lab_svc constant uuid := '01830000-0000-4000-8000-0000000000b1';
  k_pkg_svc constant uuid := '01830000-0000-4000-8000-0000000000b4';
  k_pkg_c1  constant uuid := '01830000-0000-4000-8000-0000000000c1';
  k_pkg_c2  constant uuid := '01830000-0000-4000-8000-0000000000c2';
  k_pkg_c3  constant uuid := '01830000-0000-4000-8000-0000000000c3';
  k_pkg_c4  constant uuid := '01830000-0000-4000-8000-0000000000c4';
  k_pkg_c5  constant uuid := '01830000-0000-4000-8000-0000000000c5';
  k_pkg_c6  constant uuid := '01830000-0000-4000-8000-0000000000c6';
  k_pkg_c7  constant uuid := '01830000-0000-4000-8000-0000000000c7';
  k_pkg_c8  constant uuid := '01830000-0000-4000-8000-0000000000c8';
  v_visit  uuid;
  v_min_id uuid;
  v_amounts text;
  v_header uuid;
  v_n      int;
  v_amt    numeric;
begin
  -- ---- H1: three identical ₱500 lab lines ------------------------------------
  insert into public.visits (patient_id, total_php, paid_php, payment_status)
  values (k_patient, 1500, 0, 'unpaid') returning id into v_visit;
  insert into public.test_requests (visit_id, service_id, status, requested_by, final_price_php)
  values (v_visit, k_lab_svc, 'ready_for_release', k_admin, 500),
         (v_visit, k_lab_svc, 'ready_for_release', k_admin, 500),
         (v_visit, k_lab_svc, 'ready_for_release', k_admin, 500);
  insert into public.payments (visit_id, amount_php, method, received_by) values (v_visit, 500, 'cash', k_admin);

  perform public.waive_visit_balance(v_visit, k_admin, 'H1 smoke: largest remainder');

  select test_request_id into v_min_id from public.visit_waiver_allocations
   where visit_id = v_visit order by test_request_id limit 1;
  select amount_php into v_amt from public.visit_waiver_allocations
   where visit_id = v_visit and test_request_id = v_min_id;
  if v_amt <> 333.34 then
    raise exception 'H1 FAIL: lowest test_request_id should get 333.34, got %', v_amt;
  end if;
  select count(*) into v_n from public.visit_waiver_allocations
   where visit_id = v_visit and test_request_id <> v_min_id and amount_php = 333.33;
  if v_n <> 2 then raise exception 'H1 FAIL: the other two lines should be 333.33 each, got % matching', v_n; end if;
  select sum(amount_php) into v_amt from public.visit_waiver_allocations where visit_id = v_visit;
  if v_amt <> 1000 then raise exception 'H1 FAIL: allocations sum to %, want 1000', v_amt; end if;
  raise notice 'PASS H1';

  -- ---- H2: package visit, header + 8 ₱0 components ---------------------------
  insert into public.visits (patient_id, total_php, paid_php, payment_status)
  values (k_patient, 5888, 0, 'unpaid') returning id into v_visit;
  insert into public.test_requests (visit_id, service_id, status, requested_by,
                                    base_price_php, final_price_php, is_package_header)
  values (v_visit, k_pkg_svc, 'in_progress', k_admin, 5888, 5888, true)
  returning id into v_header;
  insert into public.test_requests (visit_id, service_id, status, requested_by, final_price_php, parent_id)
  values (v_visit, k_pkg_c1, 'in_progress', k_admin, 0, v_header),
         (v_visit, k_pkg_c2, 'in_progress', k_admin, 0, v_header),
         (v_visit, k_pkg_c3, 'in_progress', k_admin, 0, v_header),
         (v_visit, k_pkg_c4, 'in_progress', k_admin, 0, v_header),
         (v_visit, k_pkg_c5, 'in_progress', k_admin, 0, v_header),
         (v_visit, k_pkg_c6, 'in_progress', k_admin, 0, v_header),
         (v_visit, k_pkg_c7, 'in_progress', k_admin, 0, v_header),
         (v_visit, k_pkg_c8, 'in_progress', k_admin, 0, v_header);

  perform public.waive_visit_balance(v_visit, k_admin, 'H2 smoke: package header only');

  select count(*) into v_n from public.visit_waiver_allocations where visit_id = v_visit;
  if v_n <> 1 then raise exception 'H2 FAIL: expected exactly 1 allocation, got %', v_n; end if;
  select amount_php into v_amt from public.visit_waiver_allocations
   where visit_id = v_visit and test_request_id = v_header;
  if v_amt <> 5888 then raise exception 'H2 FAIL: header allocation should be 5888, got %', v_amt; end if;
  raise notice 'PASS H2';

  raise notice 'PASS H';
end
$H$;

-- =============================================================================
-- I — a closed month refuses the waive, and writes nothing
-- =============================================================================
do $I$
declare
  k_admin   constant uuid := '01830000-0000-4000-8000-0000000000a1';
  k_patient constant uuid := '01830000-0000-4000-8000-0000000000a3';
  k_lab_svc constant uuid := '01830000-0000-4000-8000-0000000000b1';
  v_visit uuid;
  v_line  uuid;
  v_state text;
  v_n     int;
begin
  insert into public.visits (patient_id, total_php, paid_php, payment_status)
  values (k_patient, 500, 500, 'paid') returning id into v_visit;
  insert into public.test_requests (visit_id, service_id, status, requested_by, base_price_php, final_price_php)
  values (v_visit, k_lab_svc, 'ready_for_release', k_admin, 500, 500) returning id into v_line;

  update public.test_requests
     set status = 'released', released_at = now(), released_by = k_admin, release_medium = 'physical'
   where id = v_line;

  -- Leave a remainder to waive; still not waived, so this direct fixture
  -- write (no real payment ever existed to void) needs no bypass beyond the
  -- guard's own scope — it only freezes paid_php on a WAIVED visit.
  update public.visits set paid_php = 0, payment_status = 'unpaid' where id = v_visit;

  perform pg_temp.close_today();

  begin
    perform public.waive_visit_balance(v_visit, k_admin, 'I smoke: closed month');
    raise exception 'I FAIL: waive succeeded against a closed period';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> 'P0002' then raise; end if;
  end;

  perform pg_temp.reopen_today();

  perform 1 from public.visits where id = v_visit and payment_status = 'unpaid';
  if not found then raise exception 'I FAIL: visit payment_status changed despite the P0002 refusal'; end if;
  select count(*) into v_n from public.visit_waiver_allocations where visit_id = v_visit;
  if v_n <> 0 then raise exception 'I FAIL: % allocation row(s) survived the refused waive', v_n; end if;

  raise notice 'PASS I';
end
$I$;

-- =============================================================================
-- J / J2 — package header auto-release on waive (Leg B), open then closed period
-- =============================================================================
do $J$
declare
  k_admin  constant uuid := '01830000-0000-4000-8000-0000000000a1';
  k_patient constant uuid := '01830000-0000-4000-8000-0000000000a3';
  k_pkg_svc constant uuid := '01830000-0000-4000-8000-0000000000b4';
  k_pkg_c1  constant uuid := '01830000-0000-4000-8000-0000000000c1';
  k_pkg_c2  constant uuid := '01830000-0000-4000-8000-0000000000c2';
  k_pkg_c3  constant uuid := '01830000-0000-4000-8000-0000000000c3';
  k_pkg_c4  constant uuid := '01830000-0000-4000-8000-0000000000c4';
  k_pkg_c5  constant uuid := '01830000-0000-4000-8000-0000000000c5';
  k_pkg_c6  constant uuid := '01830000-0000-4000-8000-0000000000c6';
  k_pkg_c7  constant uuid := '01830000-0000-4000-8000-0000000000c7';
  k_pkg_c8  constant uuid := '01830000-0000-4000-8000-0000000000c8';
  v_visit  uuid;
  v_header uuid;
  v_res    jsonb;
  v_rec    timestamptz;
  v_jeid   uuid;
begin
  -- ---- J: period open ---------------------------------------------------------
  insert into public.visits (patient_id, total_php, paid_php, payment_status)
  values (k_patient, 5888, 0, 'unpaid') returning id into v_visit;
  insert into public.test_requests (visit_id, service_id, status, requested_by,
                                    base_price_php, final_price_php, is_package_header)
  values (v_visit, k_pkg_svc, 'in_progress', k_admin, 5888, 5888, true)
  returning id into v_header;
  insert into public.test_requests (visit_id, service_id, status, requested_by, final_price_php, parent_id)
  values (v_visit, k_pkg_c1, 'in_progress', k_admin, 0, v_header),
         (v_visit, k_pkg_c2, 'in_progress', k_admin, 0, v_header),
         (v_visit, k_pkg_c3, 'in_progress', k_admin, 0, v_header),
         (v_visit, k_pkg_c4, 'in_progress', k_admin, 0, v_header),
         (v_visit, k_pkg_c5, 'in_progress', k_admin, 0, v_header),
         (v_visit, k_pkg_c6, 'in_progress', k_admin, 0, v_header),
         (v_visit, k_pkg_c7, 'in_progress', k_admin, 0, v_header),
         (v_visit, k_pkg_c8, 'in_progress', k_admin, 0, v_header);

  perform 1 from public.test_requests where id = v_header and status = 'ready_for_release';
  if not found then raise exception 'J SETUP FAIL: header did not auto-promote to ready_for_release'; end if;

  -- Release all 8 components while the visit is unpaid (bypass — the fixture
  -- only needs the released columns set, matching 0172's idiom).
  set local session_replication_role = replica;
  update public.test_requests
     set status = 'released', released_at = now(), released_by = k_admin, release_medium = 'other'
   where parent_id = v_header;
  set local session_replication_role = origin;

  perform 1 from public.test_requests where id = v_header and status = 'ready_for_release';
  if not found then raise exception 'J SETUP FAIL: header released early (bypass leaked a trigger?)'; end if;

  v_res := public.waive_visit_balance(v_visit, k_admin, 'J smoke: header auto-release');

  perform 1 from public.test_requests where id = v_header and status = 'released';
  if not found then raise exception 'J FAIL: header did not auto-release inside the waive'; end if;
  select recognised_at, journal_entry_id into v_rec, v_jeid
    from public.visit_waiver_allocations where test_request_id = v_header;
  if v_rec is null or v_jeid is null then raise exception 'J FAIL: header allocation not recognised/folded'; end if;
  if pg_temp.dr(v_jeid, '4910') <> 5888 or pg_temp.cr(v_jeid, '4100') <> 5888 then
    raise exception 'J FAIL: header release JE wrong (4910 dr=%, 4100 cr=%)', pg_temp.dr(v_jeid, '4910'), pg_temp.cr(v_jeid, '4100');
  end if;
  if (v_res->>'headers_pending')::int <> 0 then
    raise exception 'J FAIL: headers_pending should be 0, got %', v_res->>'headers_pending';
  end if;
  raise notice 'PASS J';

  -- ---- J2: period closed -------------------------------------------------------
  declare
    v_visit2  uuid;
    v_header2 uuid;
    v_res2    jsonb;
  begin
    insert into public.visits (patient_id, total_php, paid_php, payment_status)
    values (k_patient, 5888, 0, 'unpaid') returning id into v_visit2;
    insert into public.test_requests (visit_id, service_id, status, requested_by,
                                      base_price_php, final_price_php, is_package_header)
    values (v_visit2, k_pkg_svc, 'in_progress', k_admin, 5888, 5888, true)
    returning id into v_header2;
    insert into public.test_requests (visit_id, service_id, status, requested_by, final_price_php, parent_id)
    values (v_visit2, k_pkg_c1, 'in_progress', k_admin, 0, v_header2),
           (v_visit2, k_pkg_c2, 'in_progress', k_admin, 0, v_header2),
           (v_visit2, k_pkg_c3, 'in_progress', k_admin, 0, v_header2),
           (v_visit2, k_pkg_c4, 'in_progress', k_admin, 0, v_header2),
           (v_visit2, k_pkg_c5, 'in_progress', k_admin, 0, v_header2),
           (v_visit2, k_pkg_c6, 'in_progress', k_admin, 0, v_header2),
           (v_visit2, k_pkg_c7, 'in_progress', k_admin, 0, v_header2),
           (v_visit2, k_pkg_c8, 'in_progress', k_admin, 0, v_header2);

    set local session_replication_role = replica;
    update public.test_requests
       set status = 'released', released_at = now(), released_by = k_admin, release_medium = 'other'
     where parent_id = v_header2;
    set local session_replication_role = origin;

    perform pg_temp.close_today();

    -- The waive itself must SUCCEED (nothing standalone to post); only the
    -- header's own auto-release attempt fails and is caught by Leg B.
    v_res2 := public.waive_visit_balance(v_visit2, k_admin, 'J2 smoke: header auto-release, closed month');

    perform 1 from public.visits where id = v_visit2 and payment_status = 'waived';
    if not found then raise exception 'J2 FAIL: the waive itself should have succeeded'; end if;
    perform 1 from public.test_requests where id = v_header2 and status = 'ready_for_release';
    if not found then raise exception 'J2 FAIL: header should still be ready_for_release'; end if;
    if not exists (
      select 1 from public.audit_log
       where action = 'test_request.header_auto_release_failed'
         and resource_id = v_header2
         and metadata->>'sqlstate' = 'P0002'
    ) then
      raise exception 'J2 FAIL: no header_auto_release_failed audit row with sqlstate P0002';
    end if;
    select recognised_at, journal_entry_id into v_rec, v_jeid
      from public.visit_waiver_allocations where test_request_id = v_header2;
    if v_rec is not null or v_jeid is not null then
      raise exception 'J2 FAIL: header allocation should still be unrecognised';
    end if;
    if (v_res2->>'headers_pending')::int <> 1 then
      raise exception 'J2 FAIL: headers_pending should be 1, got %', v_res2->>'headers_pending';
    end if;

    perform pg_temp.reopen_today();

    -- Release by hand now that the period is open: folded.
    update public.test_requests
       set status = 'released', released_at = now(), released_by = k_admin, release_medium = 'physical'
     where id = v_header2;
    select recognised_at into v_rec from public.visit_waiver_allocations where test_request_id = v_header2;
    if v_rec is null then raise exception 'J2 FAIL: header allocation still unrecognised after the manual release'; end if;

    raise notice 'PASS J2';
  end;
end
$J$;

-- =============================================================================
-- K — an ordinary, never-waived visit is untouched by 0183 [CR-1]
-- =============================================================================
do $K$
declare
  k_admin   constant uuid := '01830000-0000-4000-8000-0000000000a1';
  k_patient constant uuid := '01830000-0000-4000-8000-0000000000a3';
  k_lab_svc constant uuid := '01830000-0000-4000-8000-0000000000b1';
  v_visit uuid;
  v_line  uuid;
  v_n     int;
  v_je_line1 uuid;
  v_je_line2 uuid;
begin
  insert into public.visits (patient_id, total_php, paid_php, payment_status)
  values (k_patient, 500, 500, 'paid') returning id into v_visit;
  insert into public.test_requests (visit_id, service_id, status, requested_by, base_price_php, final_price_php)
  values (v_visit, k_lab_svc, 'ready_for_release', k_admin, 500, 500) returning id into v_line;

  update public.test_requests
     set status = 'released', released_at = now(), released_by = k_admin, release_medium = 'physical'
   where id = v_line;
  select id into v_je_line1 from public.journal_entries
   where source_kind = 'test_request' and source_id = v_line and status = 'posted';
  if v_je_line1 is null then
    raise exception 'K FAIL: release did not post a JE';
  end if;

  update public.test_requests
     set status = 'ready_for_release', released_at = null, released_by = null, release_medium = null
   where id = v_line;

  update public.test_requests
     set status = 'released', released_at = now(), released_by = k_admin, release_medium = 'physical'
   where id = v_line;
  select id into v_je_line2 from public.journal_entries
   where source_kind = 'test_request' and source_id = v_line and status = 'posted';
  if v_je_line2 is null or v_je_line2 = v_je_line1 then
    raise exception 'K FAIL: re-release did not produce a fresh posted JE (got %, original %)', v_je_line2, v_je_line1;
  end if;

  -- Cancel must reverse THIS (re-release) JE specifically, not merely find
  -- some reversal somewhere — the undo step already reversed v_je_line1, so
  -- an unscoped check here would pass even if the cancel were a no-op.
  update public.test_requests set status = 'cancelled' where id = v_line;
  if (select status from public.journal_entries where id = v_je_line2) <> 'reversed' then
    raise exception 'K FAIL: the re-release JE was not marked reversed after cancel';
  end if;
  if not exists (select 1 from public.journal_entries where reverses = v_je_line2 and status = 'posted') then
    raise exception 'K FAIL: cancel did not post a mirrored reversal of the re-release JE';
  end if;

  select count(*) into v_n from public.visit_waiver_allocations where test_request_id = v_line;
  if v_n <> 0 then raise exception 'K FAIL: % allocation row(s) exist for a never-waived line', v_n; end if;

  raise notice 'PASS K';
end
$K$;

-- =============================================================================
-- L — line freeze on a waived visit [CR-4], cancelled-line reactivation [CR-13],
-- and that an already-seen live line still runs its normal lifecycle
-- =============================================================================
do $L$
declare
  k_admin      constant uuid := '01830000-0000-4000-8000-0000000000a1';
  k_patient    constant uuid := '01830000-0000-4000-8000-0000000000a3';
  k_lab_svc    constant uuid := '01830000-0000-4000-8000-0000000000b1';
  k_legacy_run constant uuid := '01830000-0000-4000-8000-0000000000d1';
  k_pkg_svc    constant uuid := '01830000-0000-4000-8000-0000000000b4';
  v_visit  uuid;
  v_other  uuid;
  v_live   uuid;
  v_deleted uuid;
  v_header uuid;
  v_state  text;
begin
  -- ---- L1: provenance / restore / reprice / reparent / move freeze -----------
  -- total_php starts at 1000 (v_live 500 + v_deleted 500): 0125's soft-delete
  -- cascade decrements visits.total_php by the deleted line's final_price_php,
  -- so after v_deleted is soft-deleted below it lands at exactly 500 — matching
  -- the one line still live, as the waive's CR-6 reconciliation check needs.
  insert into public.visits (patient_id, total_php, paid_php, payment_status)
  values (k_patient, 1000, 0, 'unpaid') returning id into v_visit;
  insert into public.visits (patient_id, total_php, paid_php, payment_status)
  values (k_patient, 500, 0, 'unpaid') returning id into v_other;

  insert into public.test_requests (visit_id, service_id, status, requested_by, base_price_php, final_price_php)
  values (v_visit, k_lab_svc, 'ready_for_release', k_admin, 500, 500) returning id into v_live;

  -- A dummy ₱0 package header on the same visit, purely so "set parent_id"
  -- below points at a valid header (fn_test_request_parent_is_header fires
  -- before our guard and must not itself reject the target).
  insert into public.test_requests (visit_id, service_id, status, requested_by, final_price_php, is_package_header)
  values (v_visit, k_pkg_svc, 'ready_for_release', k_admin, 0, true) returning id into v_header;

  insert into public.test_requests (visit_id, service_id, status, requested_by, base_price_php, final_price_php)
  values (v_visit, k_lab_svc, 'ready_for_release', k_admin, 500, 500) returning id into v_deleted;
  update public.test_requests set deleted_at = now(), deleted_by = k_admin, delete_reason = 'pre-waive test'
   where id = v_deleted;
  perform 1 from public.visits where id = v_visit and total_php = 500;
  if not found then raise exception 'L1 SETUP FAIL: expected total_php=500 after the pre-waive delete cascade'; end if;

  perform public.waive_visit_balance(v_visit, k_admin, 'L smoke: line freeze');

  -- 1. insert a new line
  begin
    insert into public.test_requests (visit_id, service_id, status, requested_by, final_price_php)
    values (v_visit, k_lab_svc, 'requested', k_admin, 100);
    raise exception 'L FAIL: insert of a new line on a waived visit was accepted';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate; if v_state <> 'P0070' then raise; end if;
  end;

  -- 2. restore a line deleted before the waive
  begin
    update public.test_requests set deleted_at = null, deleted_by = null, delete_reason = null where id = v_deleted;
    raise exception 'L FAIL: restoring a pre-waive-deleted line was accepted';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate; if v_state <> 'P0070' then raise; end if;
  end;

  -- 3. reprice
  begin
    update public.test_requests set final_price_php = 999 where id = v_live;
    raise exception 'L FAIL: reprice on a waived visit was accepted';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate; if v_state <> 'P0070' then raise; end if;
  end;

  -- 4. reparent (target is a genuine header, so only OUR guard should fire)
  begin
    update public.test_requests set parent_id = v_header where id = v_live;
    raise exception 'L FAIL: reparent on a waived visit was accepted';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate; if v_state <> 'P0070' then raise; end if;
  end;

  -- 5. move to another visit
  begin
    update public.test_requests set visit_id = v_other where id = v_live;
    raise exception 'L FAIL: moving a line off a waived visit was accepted';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate; if v_state <> 'P0070' then raise; end if;
  end;

  -- 6. provenance flip [CR-12]
  begin
    update public.test_requests set legacy_import_run_id = k_legacy_run where id = v_live;
    raise exception 'L FAIL: setting provenance on a live line on a waived visit was accepted';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate; if v_state <> 'P0070' then raise; end if;
  end;

  raise notice 'PASS L1';

  -- ---- L2: a line cancelled BEFORE the waive cannot be reactivated [CR-13] ----
  declare
    v_visit2 uuid;
    v_live2  uuid;
    v_cancelled2 uuid;
  begin
    insert into public.visits (patient_id, total_php, paid_php, payment_status)
    values (k_patient, 500, 0, 'unpaid') returning id into v_visit2;
    insert into public.test_requests (visit_id, service_id, status, requested_by, base_price_php, final_price_php)
    values (v_visit2, k_lab_svc, 'ready_for_release', k_admin, 500, 500) returning id into v_live2;
    insert into public.test_requests (visit_id, service_id, status, requested_by, final_price_php)
    values (v_visit2, k_lab_svc, 'cancelled', k_admin, 500) returning id into v_cancelled2;

    perform public.waive_visit_balance(v_visit2, k_admin, 'L2 smoke: cancelled-before-waive reactivation');

    begin
      update public.test_requests set status = 'requested' where id = v_cancelled2;
      raise exception 'L2 FAIL: reactivating a pre-waive-cancelled line (requested) was accepted';
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate; if v_state <> 'P0070' then raise; end if;
    end;
    begin
      update public.test_requests set status = 'released' where id = v_cancelled2;
      raise exception 'L2 FAIL: reactivating a pre-waive-cancelled line (released) was accepted';
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate; if v_state <> 'P0070' then raise; end if;
    end;

    -- The live line the allocation saw still runs its normal lifecycle.
    update public.test_requests
       set status = 'released', released_at = now(), released_by = k_admin, release_medium = 'physical'
     where id = v_live2;
    perform 1 from public.test_requests where id = v_live2 and status = 'released';
    if not found then raise exception 'L2 FAIL: release of the live line was not allowed'; end if;

    update public.test_requests
       set status = 'ready_for_release', released_at = null, released_by = null, release_medium = null
     where id = v_live2;
    perform 1 from public.test_requests where id = v_live2 and status = 'ready_for_release';
    if not found then raise exception 'L2 FAIL: undo-release of the live line was not allowed'; end if;

    update public.test_requests
       set status = 'released', released_at = now(), released_by = k_admin, release_medium = 'physical'
     where id = v_live2;
    update public.test_requests set status = 'cancelled' where id = v_live2;
    perform 1 from public.test_requests where id = v_live2 and status = 'cancelled';
    if not found then raise exception 'L2 FAIL: cancel of the live line was not allowed'; end if;

    raise notice 'PASS L2';
  end;

  raise notice 'PASS L';
end
$L$;

-- =============================================================================
-- M — reconciliation refusals [CR-6]
-- =============================================================================
do $M$
declare
  k_admin   constant uuid := '01830000-0000-4000-8000-0000000000a1';
  k_patient constant uuid := '01830000-0000-4000-8000-0000000000a3';
  k_lab_svc constant uuid := '01830000-0000-4000-8000-0000000000b1';
  v_visit uuid;
  v_line  uuid;
  v_pay   uuid;
  v_je    uuid;
  v_state text;
  v_msg   text;
begin
  -- ---- M1: total smaller than its lines ---------------------------------------
  insert into public.visits (patient_id, total_php, paid_php, payment_status)
  values (k_patient, 500, 0, 'unpaid') returning id into v_visit;
  insert into public.test_requests (visit_id, service_id, status, requested_by, final_price_php)
  values (v_visit, k_lab_svc, 'ready_for_release', k_admin, 1000);
  begin
    perform public.waive_visit_balance(v_visit, k_admin, 'M1 smoke');
    raise exception 'M1 FAIL: total/line mismatch (500 vs 1000) was allowed';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> 'P0071' then raise; end if;
    if v_msg not like '%₱500.00%' or v_msg not like '%₱1,000.00%' then
      raise exception 'M1 FAIL: message does not name both amounts: %', v_msg;
    end if;
  end;
  raise notice 'PASS M1';

  -- ---- M2: total larger than its lines -----------------------------------------
  insert into public.visits (patient_id, total_php, paid_php, payment_status)
  values (k_patient, 1500, 0, 'unpaid') returning id into v_visit;
  insert into public.test_requests (visit_id, service_id, status, requested_by, final_price_php)
  values (v_visit, k_lab_svc, 'ready_for_release', k_admin, 1000);
  begin
    perform public.waive_visit_balance(v_visit, k_admin, 'M2 smoke');
    raise exception 'M2 FAIL: total/line mismatch (1500 vs 1000) was allowed';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate; if v_state <> 'P0071' then raise; end if;
  end;
  raise notice 'PASS M2';

  -- ---- M3: a released live line with no posted JE ------------------------------
  insert into public.visits (patient_id, total_php, paid_php, payment_status)
  values (k_patient, 500, 500, 'paid') returning id into v_visit;
  insert into public.test_requests (visit_id, service_id, status, requested_by, base_price_php, final_price_php)
  values (v_visit, k_lab_svc, 'ready_for_release', k_admin, 500, 500) returning id into v_line;
  insert into public.payments (visit_id, amount_php, method, received_by) values (v_visit, 500, 'cash', k_admin)
  returning id into v_pay;

  update public.test_requests
     set status = 'released', released_at = now(), released_by = k_admin, release_medium = 'physical'
   where id = v_line;
  select id into v_je from public.journal_entries
   where source_kind = 'test_request' and source_id = v_line and status = 'posted';
  if v_je is null then raise exception 'M3 SETUP FAIL: no release JE'; end if;

  update public.payments set voided_at = now(), voided_by = k_admin, void_reason = 'pre-waive void' where id = v_pay;

  set local session_replication_role = replica;
  delete from public.journal_lines where entry_id = v_je;
  delete from public.journal_entries where id = v_je;
  set local session_replication_role = origin;

  begin
    perform public.waive_visit_balance(v_visit, k_admin, 'M3 smoke: missing JE');
    raise exception 'M3 FAIL: a released line missing its JE was allowed to waive';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> 'P0071' then raise; end if;
    if v_msg not like '%no journal entry%' then
      raise exception 'M3 FAIL: unexpected message: %', v_msg;
    end if;
  end;
  raise notice 'PASS M3';

  raise notice 'PASS M';
end
$M$;

-- =============================================================================
-- N — a gift code redemption in flight [CR-7]
-- =============================================================================
do $N$
declare
  k_admin   constant uuid := '01830000-0000-4000-8000-0000000000a1';
  k_patient constant uuid := '01830000-0000-4000-8000-0000000000a3';
  k_lab_svc constant uuid := '01830000-0000-4000-8000-0000000000b1';
  v_visit uuid;
  v_pay   uuid;
  v_state text;
begin
  insert into public.visits (patient_id, total_php, paid_php, payment_status)
  values (k_patient, 800, 0, 'unpaid') returning id into v_visit;
  insert into public.test_requests (visit_id, service_id, status, requested_by, final_price_php)
  values (v_visit, k_lab_svc, 'ready_for_release', k_admin, 800);
  insert into public.payments (visit_id, amount_php, method, received_by) values (v_visit, 300, 'gift_code', k_admin)
  returning id into v_pay;

  begin
    perform public.waive_visit_balance(v_visit, k_admin, 'N smoke: gift code in flight');
    raise exception 'N FAIL: waive proceeded with an unlinked in-flight gift code payment';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate; if v_state <> 'P0071' then raise; end if;
  end;

  insert into public.gift_codes (code, face_value_php, status, redeemed_payment_id)
  values ('GC-WAIV-0183-CASN', 300, 'generated', v_pay);

  perform public.waive_visit_balance(v_visit, k_admin, 'N smoke: gift code linked');
  perform 1 from public.visits where id = v_visit and payment_status = 'waived' and waived_php = 500;
  if not found then raise exception 'N FAIL: waive did not proceed once the voucher was linked'; end if;

  raise notice 'PASS N';
end
$N$;

do $$
begin
  raise notice 'ALL PASS: 0183 waived balance GL smoke A-N';
end
$$;

rollback;
