-- =============================================================================
-- 0184_patient_lifecycle_locks.sql — patient delete PR 3a
-- =============================================================================
-- Race-proofs patient deletion (0167). Spec:
-- docs/superpowers/specs/2026-09-24-patient-delete-design.md, "PR 3 revision".
--
-- ONE LOCK, TWO MODES. Key (hashtext('patient_lifecycle'), hashtext(patient_id::text)),
-- the key 0167's delete_patient / restore_patient already take EXCLUSIVE.
-- Every other patient-owned write takes it SHARED, so writers never wait for
-- each other, only for a delete/restore; a statement that moves a row to a
-- different patient takes it EXCLUSIVE on old and new (sorted). Lock order
-- everywhere: advisory lock(s) first, sorted by key → row locks → fresh re-read.
-- Never shared-then-exclusive on one key in one transaction (upgrades deadlock).
--
-- (1) lifecycle_lock / lifecycle_lock_and_assert, the result-membership lock
--     lifecycle_lock_results, and resolvers that follow EVERY patient-bearing reference
-- (2) delete_patient / restore_patient re-created with FOR NO KEY UPDATE
-- (3) enforce_patient_activity(): the default-refuse guard, as a_lifecycle_guard
-- (4) existing RPCs take the lock before their row locks
-- (5) resolve_patient_guarded: case-insensitive, locked, re-read
-- (6) create_visit_encounter
-- (7) result_create_linked
-- (8) record_hmo_settlement
-- (9) reschedule_closure_appointments
-- (10) current_patient_id JWT-only, set_patient_context dropped, notification_skip_summary
-- (11) post-conditions
--
-- P-codes: P0072 the patient on a record changed while it was being saved
-- (the transaction aborted; retry once), P0073 a visit encounter could not be
-- created (message passes through). Input validation in the new RPCs uses
-- 22023 / 42501 (messages pass through translatePgError). P0058 (0167) is
-- the refusal on an inactive patient.
--
-- Re-runnable on the local stack. Function bodies copied from earlier
-- migrations say which file and lines they came from.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- (1) Lock primitives. SECURITY DEFINER, owned by the migration owner (which
-- owns every patient-owned table and is not subject to their RLS): an
-- RLS-hidden parent can never look like "no patient". EXECUTE is revoked from
-- every runtime role; guard triggers and the RPCs below call these as their
-- owner. VOLATILE: every statement after a lock wait takes a fresh snapshot.
-- ---------------------------------------------------------------------------
create or replace function public.lifecycle_norm(p_ids uuid[])
returns uuid[]
language sql
immutable
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(array_agg(distinct x order by x), '{}'::uuid[]) from unnest(p_ids) x;
$$;

-- Takes the lifecycle lock on every distinct patient, in ascending key order.
-- Lock only — the resolver (5) re-reads and decides itself.
create or replace function public.lifecycle_lock(p_patient_ids uuid[], p_exclusive boolean)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_key int;
begin
  for v_key in
    select distinct hashtext(x::text) as k
      from unnest(coalesce(p_patient_ids, '{}'::uuid[])) x
     where x is not null
     order by k
  loop
    if p_exclusive then
      perform pg_advisory_xact_lock(hashtext('patient_lifecycle'), v_key);
    else
      perform pg_advisory_xact_lock_shared(hashtext('patient_lifecycle'), v_key);
    end if;
  end loop;
end;
$$;

-- Lock, then re-read every patient with a fresh statement. A NULL element is
-- a required parent that did not resolve: fail closed.
create or replace function public.lifecycle_lock_and_assert(p_patient_ids uuid[], p_exclusive boolean)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_bad record;
begin
  if p_patient_ids is null or cardinality(p_patient_ids) = 0 then
    return;
  end if;
  if array_position(p_patient_ids, null) is not null then
    raise exception 'this record''s patient could not be found — reload and try again'
      using errcode = 'P0058';
  end if;

  perform public.lifecycle_lock(p_patient_ids, p_exclusive);

  select x as id, p.drm_id, p.deleted_at, p.merged_into_id
    into v_bad
    from unnest(p_patient_ids) x
    left join public.patients p on p.id = x
   where p.id is null or p.deleted_at is not null or p.merged_into_id is not null
   order by x
   limit 1;
  if found then
    if v_bad.drm_id is null then
      raise exception 'this record''s patient could not be found — reload and try again'
        using errcode = 'P0058';
    elsif v_bad.merged_into_id is not null then
      raise exception 'patient % was merged into another record — use the kept record', v_bad.drm_id
        using errcode = 'P0058';
    else
      raise exception 'patient % is deleted — restore the record before changing it', v_bad.drm_id
        using errcode = 'P0058';
    end if;
  end if;
end;
$$;

-- Patient paths. A parent that does not exist yields a NULL element.
create or replace function public.lifecycle_patients_of_visits(p_visit_ids uuid[])
returns uuid[]
language sql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(array_agg(v.patient_id), '{}'::uuid[])
    from unnest(p_visit_ids) x
    left join public.visits v on v.id = x;
$$;

create or replace function public.lifecycle_patients_of_test_requests(p_test_request_ids uuid[])
returns uuid[]
language sql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(array_agg(v.patient_id), '{}'::uuid[])
    from unnest(p_test_request_ids) x
    left join public.test_requests tr on tr.id = x
    left join public.visits v on v.id = tr.visit_id;
$$;

-- A result has no patient until it is linked (0051): an unlinked draft is
-- inert. Callers hold the result's MEMBERSHIP lock (below) before calling
-- this, so the answer cannot change under them. p_except_test leaves one link
-- out (a junction UPDATE judges the result's OTHER links).
create or replace function public.lifecycle_patients_of_result(p_result_id uuid, p_except_test uuid default null)
returns uuid[]
language sql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(array_agg(v.patient_id), '{}'::uuid[])
    from public.result_test_requests rtr
    left join public.test_requests tr on tr.id = rtr.test_request_id
    left join public.visits v on v.id = tr.visit_id
   where rtr.result_id = p_result_id
     and rtr.test_request_id is distinct from p_except_test;
$$;

-- A result amendment belongs to its result's patients and its test's patient.
create or replace function public.lifecycle_patients_of_amendments(p_amendment_ids uuid[])
returns uuid[]
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_out uuid[] := '{}';
  a     record;
begin
  for a in
    select x, am.id, am.result_id, am.test_request_id
      from unnest(p_amendment_ids) x
      left join public.result_amendments am on am.id = x
  loop
    if a.id is null then
      v_out := v_out || null::uuid;   -- missing: fail closed
    else
      v_out := v_out || public.lifecycle_patients_of_result(a.result_id)
                     || public.lifecycle_patients_of_test_requests(array[a.test_request_id]);
    end if;
  end loop;
  return v_out;
end;
$$;

-- An HMO allocation belongs to its claim item's patient and its payment's patient.
create or replace function public.lifecycle_patients_of_allocations(p_allocation_ids uuid[])
returns uuid[]
language sql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(array_agg(pid), '{}'::uuid[]) from (
    select v1.patient_id as pid
      from unnest(p_allocation_ids) x
      left join public.hmo_payment_allocations al on al.id = x
      left join public.hmo_claim_items i on i.id = al.item_id
      left join public.test_requests tr on tr.id = i.test_request_id
      left join public.visits v1 on v1.id = tr.visit_id
    union all
    select v2.patient_id
      from unnest(p_allocation_ids) x
      left join public.hmo_payment_allocations al on al.id = x
      left join public.payments pay on pay.id = al.payment_id
      left join public.visits v2 on v2.id = pay.visit_id
  ) s;
$$;

-- One reference → its patients. A NULL/empty reference names nobody ('{}');
-- a reference to a row that does not exist yields a NULL element (fail closed).
create or replace function public.lifecycle_via(p_kind text, p_id text)
returns uuid[]
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if nullif(p_id, '') is null then
    return '{}'::uuid[];
  end if;
  return case p_kind
    when 'patient'      then array[p_id::uuid]   -- a missing patient fails in lifecycle_lock_and_assert
    when 'visit'        then public.lifecycle_patients_of_visits(array[p_id::uuid])
    when 'test_request' then public.lifecycle_patients_of_test_requests(array[p_id::uuid])
    when 'payment'      then public.lifecycle_patients_of_payments(array[p_id::uuid])
    when 'result'       then public.lifecycle_patients_of_result(p_id::uuid)
    when 'amendment'    then public.lifecycle_patients_of_amendments(array[p_id::uuid])
    when 'hmo_item'     then public.lifecycle_patients_of_hmo_items(array[p_id::uuid])
    when 'allocation'   then public.lifecycle_patients_of_allocations(array[p_id::uuid])
  end;
end;
$$;

-- The results whose MEMBERSHIP a results-family row depends on.
create or replace function public.lifecycle_result_ids_of_row(p_table text, p_row jsonb)
returns uuid[]
language sql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select array_remove(case
    when p_row is null then '{}'::uuid[]
    when p_table = 'results' then array[nullif(p_row ->> 'id', '')::uuid]
    when p_table in ('result_test_requests', 'result_values', 'result_amendments')
      then array[nullif(p_row ->> 'result_id', '')::uuid]
    when p_table = 'critical_alerts'
      then array[nullif(p_row ->> 'result_id', '')::uuid,
                 (select am.result_id from public.result_amendments am
                   where am.id = nullif(p_row ->> 'withdrawn_by_amendment', '')::uuid)]
    else '{}'::uuid[]
  end, null);
$$;

-- The result-membership lock: key (hashtext('result_membership'),
-- hashtext(result_id)), sorted, NULLs ignored. EXCLUSIVE when the write
-- changes which tests a result holds (result_test_requests insert/update/
-- delete, results delete); SHARED for every other results-family write. Taken
-- BEFORE the patient lock — the patient set of a result is only stable while
-- its membership is.
create or replace function public.lifecycle_lock_results(p_result_ids uuid[], p_exclusive boolean)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_key int;
begin
  for v_key in
    select distinct hashtext(x::text) as k
      from unnest(coalesce(p_result_ids, '{}'::uuid[])) x
     where x is not null
     order by k
  loop
    if p_exclusive then
      perform pg_advisory_xact_lock(hashtext('result_membership'), v_key);
    else
      perform pg_advisory_xact_lock_shared(hashtext('result_membership'), v_key);
    end if;
  end loop;
end;
$$;

create or replace function public.lifecycle_patients_of_hmo_items(p_item_ids uuid[])
returns uuid[]
language sql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(array_agg(v.patient_id), '{}'::uuid[])
    from unnest(p_item_ids) x
    left join public.hmo_claim_items i on i.id = x
    left join public.test_requests tr on tr.id = i.test_request_id
    left join public.visits v on v.id = tr.visit_id;
$$;

create or replace function public.lifecycle_patients_of_payments(p_payment_ids uuid[])
returns uuid[]
language sql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(array_agg(v.patient_id), '{}'::uuid[])
    from unnest(p_payment_ids) x
    left join public.payments pay on pay.id = x
    left join public.visits v on v.id = pay.visit_id;
$$;

-- The patients a row (as jsonb) belongs to: the UNION over EVERY
-- patient-bearing reference the row carries (Facts table; Codex plan review
-- P1-1), so references that disagree are all locked and asserted, never just
-- the one path someone thought of. For a DELETE a vanished parent is dropped:
-- it can only be a cascade from the parent's own (guarded) delete. A new
-- patient-bearing column on any of these tables must be added here AND to
-- the Facts table; s14.5 fails on an FK the resolver does not know.
create or replace function public.lifecycle_patients_of_row(p_table text, p_row jsonb, p_for_delete boolean)
returns uuid[]
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v uuid[];
begin
  v := case p_table
    when 'visits'                  then public.lifecycle_via('patient', p_row ->> 'patient_id')
                                        || case when p_row ->> 'patient_id' is null then array[null::uuid] else '{}'::uuid[] end
    when 'patient_consents'        then public.lifecycle_via('patient', p_row ->> 'patient_id')
                                        || case when p_row ->> 'patient_id' is null then array[null::uuid] else '{}'::uuid[] end
    when 'appointments'            then public.lifecycle_via('patient', p_row ->> 'patient_id')
    when 'appointment_attachments' then public.lifecycle_via('patient', p_row ->> 'patient_id')
    when 'test_requests'           then public.lifecycle_via('visit', p_row ->> 'visit_id')
                                        || public.lifecycle_via('test_request', p_row ->> 'parent_id')
    when 'payments'                then public.lifecycle_via('visit', p_row ->> 'visit_id')
                                        || public.lifecycle_via('payment', p_row ->> 'corrects_payment_id')
    when 'visit_pins'              then public.lifecycle_via('visit', p_row ->> 'visit_id')
    when 'results'                 then public.lifecycle_via('result', p_row ->> 'id')
    when 'result_test_requests'    then public.lifecycle_via('test_request', p_row ->> 'test_request_id')
                                        || public.lifecycle_via('result', p_row ->> 'result_id')
    when 'result_values'           then public.lifecycle_via('result', p_row ->> 'result_id')
    when 'result_amendments'       then public.lifecycle_via('result', p_row ->> 'result_id')
                                        || public.lifecycle_via('test_request', p_row ->> 'test_request_id')
    when 'critical_alerts'         then public.lifecycle_via('result', p_row ->> 'result_id')
                                        || public.lifecycle_via('test_request', p_row ->> 'test_request_id')
                                        || public.lifecycle_via('patient', p_row ->> 'patient_id')
                                        || public.lifecycle_via('amendment', p_row ->> 'withdrawn_by_amendment')
    when 'hmo_claim_items'         then public.lifecycle_via('test_request', p_row ->> 'test_request_id')
    when 'hmo_payment_allocations' then public.lifecycle_via('hmo_item', p_row ->> 'item_id')
                                        || public.lifecycle_via('payment', p_row ->> 'payment_id')
    when 'hmo_claim_resolutions'   then public.lifecycle_via('hmo_item', p_row ->> 'item_id')
    when 'doctor_pf_entries'       then public.lifecycle_via('test_request', p_row ->> 'test_request_id')
                                        || public.lifecycle_via('allocation', p_row ->> 'hmo_allocation_id')
  end;
  if v is null then
    raise exception 'lifecycle guard: no patient path for table %', p_table using errcode = 'P0058';
  end if;
  if p_for_delete then
    v := array(select x from unnest(v) x where x is not null);
  end if;
  return v;
end;
$$;

revoke all on function public.lifecycle_norm(uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.lifecycle_lock(uuid[], boolean) from public, anon, authenticated, service_role;
revoke all on function public.lifecycle_lock_and_assert(uuid[], boolean) from public, anon, authenticated, service_role;
revoke all on function public.lifecycle_lock_results(uuid[], boolean) from public, anon, authenticated, service_role;
revoke all on function public.lifecycle_patients_of_visits(uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.lifecycle_patients_of_test_requests(uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.lifecycle_patients_of_result(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.lifecycle_patients_of_hmo_items(uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.lifecycle_patients_of_payments(uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.lifecycle_patients_of_amendments(uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.lifecycle_patients_of_allocations(uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.lifecycle_via(text, text) from public, anon, authenticated, service_role;
revoke all on function public.lifecycle_result_ids_of_row(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.lifecycle_patients_of_row(text, jsonb, boolean) from public, anon, authenticated, service_role;
