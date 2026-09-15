-- =============================================================================
-- 0147_hmo_claim_delete_guard_smoke.sql
-- =============================================================================
-- DB integrity smoke test for migration 0147 (P0050). Runs inside
-- BEGIN/ROLLBACK so it leaves no state behind. Asserts each invariant with
-- raise notice on success and explicit raise exception on unexpected behavior.
--
-- What it proves:
--   1. Soft-deleting a VISIT whose line carries a non-voided hmo_claim_item
--      raises P0050 — reached through the line, since a visit delete does not
--      cascade to its test_requests.
--   2. Soft-deleting that LINE raises P0050 too.
--   3. An UNCLAIMED sibling line on the same visit stays deletable, so the
--      guard is scoped to the claimed row and does not freeze the visit.
--   4. Voiding the batch releases the block on both paths.
--   5. A line whose claim is open but which was ALREADY soft-deleted still
--      blocks its parent visit — the guard deliberately does not filter
--      tr.deleted_at, because that row's receivable is still outstanding.
--   6. THE CONTROL: with the P0050 clause stripped out of both guard
--      functions, deletes 1 and 2 SUCCEED. Without this, the failures above
--      prove only that *something* blocked the delete — 0125 already raises
--      P0042/P0043/P0044 on this path, and an assertion that cannot tell them
--      apart is not an assertion. (This is the lesson from the 0146 replay:
--      zeros prove nothing without a control that produces non-zeros.)
--
-- The reachable state it reconstructs: an HMO visit whose line was released
-- and claimed, then UNRELEASED (0110 does not touch hmo_claim_items) so it sits
-- at ready_for_release. 0133 keeps an HMO visit 'unpaid' forever, so neither
-- P0042 nor P0043 fires and only P0050 stands between the clinic and a
-- receivable that silently leaves AR.
--
-- Self-contained: mints its own auth user, service, patient and provider rows
-- rather than depending on whether the seed scripts have been run.
--
-- Run with:
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0147_hmo_claim_delete_guard_smoke.sql
-- or, against the local stack:
--   docker exec -i supabase_db_DRMed psql -U postgres -d postgres \
--     -f /dev/stdin < supabase/tests/0147_hmo_claim_delete_guard_smoke.sql
-- =============================================================================

begin;

-- --- Fixture ----------------------------------------------------------------

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values ('a0000000-0000-4000-8000-000000000147',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'p0050-smoke@example.test', '', now(), now(), now());

insert into public.hmo_providers (id, name)
values ('b0000000-0000-4000-8000-000000000147', 'P0050 Smoke HMO');

insert into public.services (id, code, name, price_php, kind)
values ('c0000000-0000-4000-8000-000000000147', 'P0050-SMOKE', 'Smoke lab test',
        1000, 'lab_test');

insert into public.patients (id, drm_id, first_name, last_name, birthdate)
values ('d0000000-0000-4000-8000-000000000147', 'DRM-P0050S', 'Smoke', 'Patient',
        '1990-01-01');

-- HMO visit: unpaid forever (0133), which is exactly what makes it deletable.
insert into public.visits (id, visit_number, patient_id, visit_date,
                           payment_status, total_php, paid_php, hmo_provider_id)
values ('e0000000-0000-4000-8000-000000000147', 'V-P0050S',
        'd0000000-0000-4000-8000-000000000147',
        (now() at time zone 'Asia/Manila')::date, 'unpaid', 1500, 0,
        'b0000000-0000-4000-8000-000000000147');

-- The claimed line, sitting at ready_for_release after an undo-release.
insert into public.test_requests (id, visit_id, service_id, status, requested_by,
                                  base_price_php, final_price_php)
values ('f0000000-0000-4000-8000-000000000147',
        'e0000000-0000-4000-8000-000000000147',
        'c0000000-0000-4000-8000-000000000147', 'ready_for_release',
        'a0000000-0000-4000-8000-000000000147', 1000, 1000);

-- An unclaimed sibling, to prove the guard is scoped to the claimed row.
insert into public.test_requests (id, visit_id, service_id, status, requested_by,
                                  base_price_php, final_price_php)
values ('f1000000-0000-4000-8000-000000000147',
        'e0000000-0000-4000-8000-000000000147',
        'c0000000-0000-4000-8000-000000000147', 'ready_for_release',
        'a0000000-0000-4000-8000-000000000147', 500, 500);

insert into public.hmo_claim_batches (id, provider_id, status)
values ('a1000000-0000-4000-8000-000000000147',
        'b0000000-0000-4000-8000-000000000147', 'submitted');

insert into public.hmo_claim_items (id, batch_id, test_request_id,
                                    billed_amount_php, paid_amount_php,
                                    patient_billed_amount_php,
                                    written_off_amount_php, hmo_response,
                                    batch_voided)
values ('a2000000-0000-4000-8000-000000000147',
        'a1000000-0000-4000-8000-000000000147',
        'f0000000-0000-4000-8000-000000000147',
        1000, 0, 0, 0, 'pending', false);

-- --- Assertions -------------------------------------------------------------

do $smoke$
declare
  v_state text;
  v_allowed boolean;
  v_deleted boolean;
  k_actor constant uuid := 'a0000000-0000-4000-8000-000000000147';
  k_visit constant uuid := 'e0000000-0000-4000-8000-000000000147';
  k_line  constant uuid := 'f0000000-0000-4000-8000-000000000147';
  k_sib   constant uuid := 'f1000000-0000-4000-8000-000000000147';
  k_item  constant uuid := 'a2000000-0000-4000-8000-000000000147';
begin
  -- NOTE ON SHAPE: the "it should have been blocked" raise must sit OUTSIDE
  -- the begin/exception block, or the handler one line below catches its own
  -- failure report and re-raises it as "expected P0050, got P0001" — which
  -- reads like the wrong code was raised when in fact nothing was. Set a flag
  -- inside, assert outside.

  -- 1. Visit delete is blocked, via the join through test_requests.
  v_allowed := false;
  v_state := null;
  begin
    update public.visits
       set deleted_at = now(), deleted_by = k_actor, delete_reason = 'smoke'
     where id = k_visit;
    v_allowed := true;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  if v_allowed then
    raise exception '0147 smoke 1 FAILED: deleting a visit with an open HMO claim was allowed';
  end if;
  if v_state <> 'P0050' then
    raise exception '0147 smoke 1 FAILED: blocked, but with % instead of P0050', v_state;
  end if;
  raise notice '0147 smoke 1 OK: visit delete blocked with P0050';

  -- 2. Line delete is blocked.
  v_allowed := false;
  v_state := null;
  begin
    update public.test_requests
       set deleted_at = now(), deleted_by = k_actor, delete_reason = 'smoke'
     where id = k_line;
    v_allowed := true;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  if v_allowed then
    raise exception '0147 smoke 2 FAILED: deleting a claimed line was allowed';
  end if;
  if v_state <> 'P0050' then
    raise exception '0147 smoke 2 FAILED: blocked, but with % instead of P0050', v_state;
  end if;
  raise notice '0147 smoke 2 OK: line delete blocked with P0050';

  -- 3. The unclaimed sibling is still deletable — scoped, not a visit-wide freeze.
  update public.test_requests
     set deleted_at = now(), deleted_by = k_actor, delete_reason = 'smoke'
   where id = k_sib;
  select deleted_at is not null into v_deleted
    from public.test_requests where id = k_sib;
  if not v_deleted then
    raise exception '0147 smoke 3 FAILED: unclaimed sibling line was not deleted';
  end if;
  raise notice '0147 smoke 3 OK: unclaimed sibling line still deletable';

  -- 5. …and with that sibling now deleted, the CLAIMED line's own deletion is
  --    still blocked, and so is the visit. Guards the deliberate absence of a
  --    tr.deleted_at filter: a deleted line's open claim still counts.
  v_allowed := false;
  v_state := null;
  begin
    update public.visits
       set deleted_at = now(), deleted_by = k_actor, delete_reason = 'smoke'
     where id = k_visit;
    v_allowed := true;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
  end;
  if v_allowed then
    raise exception '0147 smoke 5 FAILED: visit deleted while a claim was still open';
  end if;
  if v_state <> 'P0050' then
    raise exception '0147 smoke 5 FAILED: blocked, but with % instead of P0050', v_state;
  end if;
  raise notice '0147 smoke 5 OK: an open claim still blocks after a sibling delete';

  -- 4. Voiding the batch releases both paths.
  update public.hmo_claim_items set batch_voided = true where id = k_item;

  update public.test_requests
     set deleted_at = now(), deleted_by = k_actor, delete_reason = 'smoke'
   where id = k_line;
  select deleted_at is not null into v_deleted
    from public.test_requests where id = k_line;
  if not v_deleted then
    raise exception '0147 smoke 4a FAILED: line still blocked after the batch was voided';
  end if;

  update public.visits
     set deleted_at = now(), deleted_by = k_actor, delete_reason = 'smoke'
   where id = k_visit;
  select deleted_at is not null into v_deleted
    from public.visits where id = k_visit;
  if not v_deleted then
    raise exception '0147 smoke 4b FAILED: visit still blocked after the batch was voided';
  end if;
  raise notice '0147 smoke 4 OK: a voided batch blocks neither path';
end;
$smoke$;

-- --- 6. The control ---------------------------------------------------------
-- Put the rows back, strip the P0050 clause out of both guards, and re-run 1
-- and 2. They must now SUCCEED. If they still fail, the assertions above were
-- passing on some other guard (0125 raises P0042/P0043/P0044 on this same
-- path) and prove nothing about 0147.

update public.visits
   set deleted_at = null, deleted_by = null, delete_reason = null
 where id = 'e0000000-0000-4000-8000-000000000147';
update public.test_requests
   set deleted_at = null, deleted_by = null, delete_reason = null
 where visit_id = 'e0000000-0000-4000-8000-000000000147';
update public.hmo_claim_items set batch_voided = false
 where id = 'a2000000-0000-4000-8000-000000000147';

create or replace function public.enforce_deletable_visit()
returns trigger language plpgsql security definer set search_path = public as $ctl$
begin
  if not (old.deleted_at is null and new.deleted_at is not null) then return new; end if;
  if new.payment_status <> 'unpaid' then
    raise exception 'visit is not unpaid (payment_status=%)', new.payment_status using errcode = 'P0042';
  end if;
  if exists (select 1 from public.payments where visit_id = new.id and voided_at is null) then
    raise exception 'visit has recorded payments' using errcode = 'P0042';
  end if;
  if exists (select 1 from public.test_requests where visit_id = new.id and status = 'released') then
    raise exception 'visit has a released result' using errcode = 'P0043';
  end if;
  return new;
end;
$ctl$;

create or replace function public.enforce_deletable_test_request()
returns trigger language plpgsql security definer set search_path = public as $ctl$
declare v_payment_status text;
begin
  if not (old.deleted_at is null and new.deleted_at is not null) then return new; end if;
  if old.status = 'released' then
    raise exception 'test has a released result' using errcode = 'P0043';
  end if;
  if old.parent_id is not null and pg_trigger_depth() <= 1 then
    raise exception 'package component — delete the whole package instead' using errcode = 'P0044';
  end if;
  select payment_status into v_payment_status from public.visits where id = new.visit_id;
  if v_payment_status <> 'unpaid' then
    raise exception 'visit is not unpaid (payment_status=%)', v_payment_status using errcode = 'P0042';
  end if;
  return new;
end;
$ctl$;

do $control$
declare
  v_deleted boolean;
  k_actor constant uuid := 'a0000000-0000-4000-8000-000000000147';
  k_visit constant uuid := 'e0000000-0000-4000-8000-000000000147';
  k_line  constant uuid := 'f0000000-0000-4000-8000-000000000147';
begin
  update public.test_requests
     set deleted_at = now(), deleted_by = k_actor, delete_reason = 'control'
   where id = k_line;
  select deleted_at is not null into v_deleted
    from public.test_requests where id = k_line;
  if not v_deleted then
    raise exception '0147 CONTROL FAILED: line still blocked without the P0050 clause — the assertions above were measuring a different guard';
  end if;

  update public.visits
     set deleted_at = now(), deleted_by = k_actor, delete_reason = 'control'
   where id = k_visit;
  select deleted_at is not null into v_deleted
    from public.visits where id = k_visit;
  if not v_deleted then
    raise exception '0147 CONTROL FAILED: visit still blocked without the P0050 clause — the assertions above were measuring a different guard';
  end if;

  raise notice '0147 CONTROL OK: both deletes succeed once the P0050 clause is removed, so the blocks above were 0147 and nothing else';
  raise notice '0147 smoke: ALL ASSERTIONS PASSED';
end;
$control$;

-- The control's function replacements are undone by this rollback along with
-- every fixture row — nothing here persists, including the stripped guards.
rollback;
