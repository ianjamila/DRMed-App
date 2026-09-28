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
-- Caveat: this is the RPC-level (delete_patient/restore_patient, and the other
-- lock-then-row-lock functions in section (4)) and guard-internal lock order —
-- it does NOT describe ordinary trigger-guarded UPDATE/DELETE traffic. For an
-- UPDATE or DELETE that fires a_lifecycle_guard, Postgres has already taken
-- the target row's lock (that is how the statement reached a BEFORE ROW
-- trigger) BEFORE the guard takes its advisory lock — the reverse of "advisory
-- lock first". That reversal is harmless against delete_patient/restore_patient
-- (they only ever take the patients row lock, never a child row's), but it is
-- exactly why two ordinary UPDATEs that touch the same two rows in opposite
-- order (move a visit onto patient A while another session moves a different
-- visit onto patient A's old patient) can deadlock on ROW locks before either
-- reaches the advisory lock — a plain Postgres 40P01, not something this lock
-- protocol can order away. This is the deadlock the two-connection race test
-- in scripts/smoke-lifecycle-locks.ts is expected to hit on a "move vs. touch"
-- race; the app retries once on 40P01 (LIFECYCLE_RETRYABLE_CODES, planned:
-- src/lib/patients/lifecycle-retry.ts), the same as P0072/40001.
--
-- (1) lifecycle_lock / lifecycle_lock_and_assert, the result-membership lock
--     lifecycle_lock_results, and resolvers that follow EVERY patient-bearing reference
-- (2) delete_patient / restore_patient re-created with FOR NO KEY UPDATE
-- (3) enforce_patient_activity(): the default-refuse guard, as a_lifecycle_guard
-- (4) existing RPCs take the lock before their row locks; (4f)
--     recompute_clinic_fee_for_unreleased gets an active-patient filter
--     instead (it is a bulk, all-patients scrub, not a single-record RPC —
--     a lock would only prove one patient active while it touches many)
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
-- This relies on READ COMMITTED (Postgres's default, and what every pooled
-- Supabase connection runs at): each statement in the function then sees a
-- fresh snapshot taken right after the lock wait. Under REPEATABLE READ the
-- re-read below would still see the transaction's ORIGINAL snapshot from
-- before the wait, defeating the whole point of re-reading after the lock —
-- nothing in the app opens a transaction at that isolation level.
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
-- a reference to a row that does not exist yields a NULL element (fail
-- closed) — EXCEPT 'result': an unlinked or missing result has no rows in
-- result_test_requests either way, so it always yields '{}' (see
-- lifecycle_patients_of_result), never a NULL element. An unrecognised
-- p_kind fails closed too (P0058), never silently drops the path.
--
-- p_for_delete (default false) governs ONLY the 'patient' kind: a patient id
-- that no longer resolves to a patients row is DROPPED (a NULL element,
-- stripped by lifecycle_patients_of_row's p_for_delete cleanup) instead of
-- failing closed, the same treatment a vanished visit/test/result parent
-- already gets. It can only happen on the OLD side of a DELETE or an UPDATE:
-- the patient row was hard-deleted earlier in THIS transaction (sheet-sync
-- undo hard-deletes patients it created; smoke fixtures do the same), which
-- cascades into patient_consents (ON DELETE CASCADE, a DELETE this function
-- sees) and appointment_attachments (ON DELETE SET NULL, an UPDATE this
-- function also sees on the OLD side). NEW-row / INSERT references are
-- unchanged — a bogus new patient id still fails via the FK, not here.
-- Signature grew a third parameter (review fix #3/#4): drop the old 2-arg
-- overload so a re-run of this migration does not leave it stranded
-- alongside the new one (create or replace cannot rename a signature).
drop function if exists public.lifecycle_via(text, text);
create or replace function public.lifecycle_via(p_kind text, p_id text, p_for_delete boolean default false)
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
  if p_kind not in ('patient', 'visit', 'test_request', 'payment', 'result',
                     'amendment', 'hmo_item', 'allocation') then
    raise exception 'lifecycle_via: unknown reference kind %', p_kind using errcode = 'P0058';
  end if;
  if p_kind = 'patient' then
    if p_for_delete then
      return coalesce((select array[p.id] from public.patients p where p.id = p_id::uuid), array[null]::uuid[]);
    end if;
    return array[p_id::uuid];   -- a missing patient fails in lifecycle_lock_and_assert
  end if;
  return case p_kind
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
-- the one path someone thought of. For a DELETE — and, since the review fix
-- below, the OLD row of an UPDATE too — a vanished parent is dropped: it can
-- only be a cascade from the parent's own (guarded) delete, or (for a
-- 'patient' reference specifically) a hard delete of the patient row itself
-- earlier in this same transaction (see lifecycle_via's p_for_delete). A new
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
    when 'visits'                  then public.lifecycle_via('patient', p_row ->> 'patient_id', p_for_delete)
                                        || case when p_row ->> 'patient_id' is null then array[null::uuid] else '{}'::uuid[] end
    when 'patient_consents'        then public.lifecycle_via('patient', p_row ->> 'patient_id', p_for_delete)
                                        || case when p_row ->> 'patient_id' is null then array[null::uuid] else '{}'::uuid[] end
    when 'appointments'            then public.lifecycle_via('patient', p_row ->> 'patient_id', p_for_delete)
    when 'appointment_attachments' then public.lifecycle_via('patient', p_row ->> 'patient_id', p_for_delete)
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
                                        || public.lifecycle_via('patient', p_row ->> 'patient_id', p_for_delete)
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
revoke all on function public.lifecycle_via(text, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.lifecycle_result_ids_of_row(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.lifecycle_patients_of_row(text, jsonb, boolean) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- (2) delete_patient / restore_patient — bodies copied from 0167 (lines
-- 529-669); the ONLY change is FOR UPDATE -> FOR NO KEY UPDATE on the patient
-- row. FOR UPDATE conflicts with the KEY SHARE a child insert's FK check
-- takes; these functions change no key column, and every writer takes its
-- advisory lock before its first FK check (BEFORE triggers run before RI
-- triggers; RPCs lock at entry), so the weaker lock cannot let a write slip
-- past a delete. postgres replaces them in place (INHERIT on
-- patient_lifecycle_writer, 0167); ownership and grants are unchanged --
-- restated below anyway.
-- ---------------------------------------------------------------------------

create or replace function public.delete_patient(
  p_patient_id uuid, p_reason text, p_note text, p_actor uuid, p_context jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_note     text := nullif(btrim(coalesce(p_note, '')), '');
  v_ip       inet;
  v_patient  record;
  v_blockers jsonb;
  v_kept     jsonb;
begin
  if p_actor is null or not exists (
    select 1 from public.staff_profiles s
     where s.id = p_actor and s.role = 'admin' and s.is_active and s.deleted_at is null
  ) then
    raise exception 'only an active admin can delete a patient record' using errcode = 'P0057';
  end if;

  if p_reason is null or p_reason not in ('duplicate', 'test_record', 'patient_request', 'other') then
    raise exception 'choose a reason: duplicate, test record, requested by patient, or other'
      using errcode = 'P0060';
  end if;
  if p_reason = 'other' and v_note is null then
    raise exception 'add a note when the reason is Other' using errcode = 'P0060';
  end if;
  if v_note is not null and length(v_note) > 500 then
    raise exception 'the note can be at most 500 characters' using errcode = 'P0060';
  end if;
  if p_context is not null and (
       jsonb_typeof(p_context) <> 'object'
       or exists (select 1 from jsonb_object_keys(p_context) k where k not in ('ip', 'user_agent'))
     ) then
    raise exception 'unexpected audit context' using errcode = 'P0060';
  end if;
  begin
    v_ip := nullif(p_context->>'ip', '')::inet;
  exception when invalid_text_representation then
    v_ip := null;
  end;

  -- Exclusive advisory lock on this patient. PR 3's writers take this SAME
  -- key SHARED, first (see the lock contract above), before touching the row.
  perform pg_advisory_xact_lock(hashtext('patient_lifecycle'), hashtext(p_patient_id::text));
  select p.id, p.drm_id, p.deleted_at, p.merged_into_id into v_patient
    from public.patients p where p.id = p_patient_id
     for no key update;
  if not found or v_patient.deleted_at is not null or v_patient.merged_into_id is not null then
    raise exception 'this patient record is not active (already deleted, merged or missing)'
      using errcode = 'P0058';
  end if;

  v_blockers := public.patient_delete_blockers(p_patient_id);
  if jsonb_array_length(v_blockers) > 0 then
    raise exception 'this patient still has open items' using
      errcode = 'P0059', detail = v_blockers::text;
  end if;

  select to_jsonb(k) - 'patient_id' into v_kept
    from public.patient_kept_counts(array[p_patient_id]) k;

  update public.patients
     set deleted_at = now(), deleted_by = p_actor, delete_reason = p_reason, delete_note = v_note
   where id = p_patient_id;

  insert into public.audit_log (actor_id, actor_type, patient_id, action, resource_type, resource_id,
                                metadata, ip_address, user_agent)
  values (p_actor, 'staff', p_patient_id, 'patient.deleted', 'patient', p_patient_id,
          jsonb_build_object('drm_id', v_patient.drm_id, 'reason', p_reason, 'note', v_note, 'kept', v_kept),
          v_ip, left(nullif(p_context->>'user_agent', ''), 512));

  return jsonb_build_object('patient_id', p_patient_id, 'drm_id', v_patient.drm_id, 'kept', v_kept);
end;
$$;

create or replace function public.restore_patient(p_patient_id uuid, p_actor uuid, p_context jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_ip      inet;
  v_patient record;
  v_kept    jsonb;
begin
  if p_actor is null or not exists (
    select 1 from public.staff_profiles s
     where s.id = p_actor and s.role = 'admin' and s.is_active and s.deleted_at is null
  ) then
    raise exception 'only an active admin can restore a patient record' using errcode = 'P0057';
  end if;
  if p_context is not null and (
       jsonb_typeof(p_context) <> 'object'
       or exists (select 1 from jsonb_object_keys(p_context) k where k not in ('ip', 'user_agent'))
     ) then
    raise exception 'unexpected audit context' using errcode = 'P0060';
  end if;
  begin
    v_ip := nullif(p_context->>'ip', '')::inet;
  exception when invalid_text_representation then
    v_ip := null;
  end;

  perform pg_advisory_xact_lock(hashtext('patient_lifecycle'), hashtext(p_patient_id::text));
  select p.id, p.drm_id, p.deleted_at, p.delete_reason, p.delete_note, p.merged_into_id into v_patient
    from public.patients p where p.id = p_patient_id
     for no key update;
  if not found then
    raise exception 'patient record not found' using errcode = 'P0058';
  end if;
  if v_patient.deleted_at is null or v_patient.merged_into_id is not null then
    raise exception 'this patient record is not deleted, so there is nothing to restore'
      using errcode = 'P0061';
  end if;

  select to_jsonb(k) - 'patient_id' into v_kept
    from public.patient_kept_counts(array[p_patient_id]) k;

  update public.patients
     set deleted_at = null, deleted_by = null, delete_reason = null, delete_note = null
   where id = p_patient_id;

  insert into public.audit_log (actor_id, actor_type, patient_id, action, resource_type, resource_id,
                                metadata, ip_address, user_agent)
  values (p_actor, 'staff', p_patient_id, 'patient.restored', 'patient', p_patient_id,
          jsonb_build_object('drm_id', v_patient.drm_id,
                             'previous_reason', v_patient.delete_reason,
                             'previous_note', v_patient.delete_note,
                             'deleted_at', v_patient.deleted_at,
                             'kept', v_kept),
          v_ip, left(nullif(p_context->>'user_agent', ''), 512));

  return jsonb_build_object('patient_id', p_patient_id, 'drm_id', v_patient.drm_id, 'kept', v_kept);
end;
$$;

revoke all on function public.delete_patient(uuid, text, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.restore_patient(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.delete_patient(uuid, text, text, uuid, jsonb) to service_role;
grant execute on function public.restore_patient(uuid, uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- (3) The guard. DEFAULT REFUSE: on an inactive (deleted or merged) patient,
-- every INSERT, UPDATE and DELETE on a patient-owned table raises P0058,
-- except these, which are allowed whatever the patient's state and so take
-- no lock at all (they add no work and move no money):
--   appointments      UPDATE changing only status, to cancelled / no_show
--                     (owner decision 2026-09-25); DELETE
--   visit_pins        UPDATE changing only failed_attempts / locked_until /
--                     last_used_at (portal sign-in bookkeeping); DELETE
--                     (retention). A PIN REISSUE changes pin_hash: refused.
--   critical_alerts   UPDATE changing only acknowledged_at / acknowledged_by
--   doctor_pf_entries UPDATE changing only disbursement_id (paying a doctor
--                     for work already done adds nothing to the patient)
--   result_amendments UPDATE changing only the 0179 follow-up bookkeeping
--                     (patient_contacted_at/_by, patient_notified_at,
--                     patient_notified_channels, patient_notify_error) — the
--                     notice sender checks the recipient itself
--   results           INSERT (unlinked until result_test_requests — inert)
-- A no-op UPDATE (nothing but updated_at changes) is always allowed: the
-- recompute triggers rewrite identical values. There is NO trigger-depth
-- exemption — a nested write (a batch reopen propagating batch_voided to an
-- inactive patient's claim item) is refused like any other.
--
-- Everything else:
--  1. results family only: take the result-MEMBERSHIP lock on every result
--     the row depends on (old and new) — EXCLUSIVE for a result_test_requests
--     write or a results DELETE (membership changes), SHARED otherwise. From
--     here on no link to those results can be added or removed until commit,
--     so the patients resolved in step 2 are the result's real patients.
--  2. resolve the row's patients over EVERY patient-bearing reference (old
--     and new), take the lifecycle lock — EXCLUSIVE on old+new when the write
--     moves the row to a different patient set, SHARED otherwise — and assert
--     all active.
--  3. resolve again: if the set moved while we waited (a visit/test moved to
--     another patient), raise P0072 (the caller retries in a fresh
--     transaction; never "lock the new one too" — a newly found key may sort
--     below one already held).
--  4. result_test_requests INSERT/UPDATE: one patient per result — the new
--     link's patient must be the patient of the result's other links
--     (23514). Under the exclusive membership lock this cannot race.
--     critical_alerts: withdrawn_by_amendment must be a correction of the
--     alert's own result (23514).
-- Before 1-4: the references other rows depend on indirectly are immutable
-- (result_amendments.result_id/test_request_id; critical_alerts.result_id/
-- test_request_id/patient_id — 23514), and 0179's ON DELETE SET NULL of
-- critical_alerts.withdrawn_by_amendment is recognised (the vanished OLD
-- reference is dropped; the alert's other references are still checked).
--
-- The OLD row is ALWAYS resolved with p_for_delete = true (not only on
-- DELETE, review fix #3): a hard delete of a patient row earlier in this
-- same transaction — sheet-sync undo, smoke fixtures — cascades into
-- patient_consents (ON DELETE CASCADE, seen here as a DELETE) and
-- appointment_attachments (ON DELETE SET NULL, seen here as an UPDATE whose
-- OLD.patient_id no longer resolves). Both must drop the vanished patient
-- reference rather than fail closed, same as a vanished visit/test/result
-- parent already does. A patient still merely SOFT-deleted continues to
-- refuse (its row still exists, so lifecycle_lock_and_assert still finds
-- deleted_at set) — only a row that has genuinely vanished is dropped.
--
-- Installed as a_lifecycle_guard: same-timing triggers fire in name order and
-- every other BEFORE trigger is tg_*/trg_*, so this lock is always taken
-- before another trigger takes a row lock (0183 is merged: `trg_payments_waived_visit_guard`
-- / `guard_payment_on_waived_visit` exists on payments today and locks visits
-- FOR UPDATE). SECURITY DEFINER (see (1)); EXECUTE revoked — firing needs none.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_patient_activity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_o       jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_n       jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_changed text[];
  v_old     uuid[] := '{}';
  v_new     uuid[] := '{}';
  v_set     uuid[];
  v_again   uuid[];
  v_owner   uuid[];
begin
  -- (a) Allowed whatever the patient's state; no lock.
  if tg_op = 'DELETE' and tg_table_name in ('appointments', 'visit_pins') then
    return old;
  end if;
  if tg_op = 'INSERT' and tg_table_name = 'results' then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    select coalesce(array_agg(k order by k), '{}'::text[])
      into v_changed
      from jsonb_object_keys(v_n) k
     where k <> 'updated_at'
       and (v_n -> k) is distinct from (v_o -> k);
    if cardinality(v_changed) = 0 then
      return new;
    end if;
    if (tg_table_name = 'appointments'
          and v_changed = array['status']
          and v_n ->> 'status' in ('cancelled', 'no_show'))
       or (tg_table_name = 'visit_pins'
          and v_changed <@ array['failed_attempts', 'last_used_at', 'locked_until'])
       or (tg_table_name = 'critical_alerts'
          and v_changed <@ array['acknowledged_at', 'acknowledged_by'])
       or (tg_table_name = 'doctor_pf_entries'
          and v_changed = array['disbursement_id'])
       or (tg_table_name = 'result_amendments'
          and v_changed <@ array['patient_contacted_at', 'patient_contacted_by', 'patient_notified_at',
                                 'patient_notified_channels', 'patient_notify_error']) then
      return new;
    end if;
  end if;

  -- (a2) Ownership references that other rows depend on INDIRECTLY are
  -- immutable (Codex recheck P1): a withdrawn alert reaches a second result
  -- through its amendment, so re-pointing an amendment at another result (or
  -- an alert at another result/test) would change what dependent writers
  -- must lock without taking any lock they conflict with. Nothing in the app
  -- or SQL rebinds these; a correction is a new row.
  --
  -- critical_alerts.patient_id is DELIBERATELY NOT in this immutable list
  -- (controller review after Tasks 5-6): the live merge flow
  -- (mergePatientsAction, admin/patient-merge/actions.ts) repoints
  -- critical_alerts.patient_id onto the kept record when it moves the
  -- alert's visit, so freezing patient_id made every alert on a merged
  -- source patient un-repointable (23514) and, once the source was
  -- tombstoned, un-withdrawable/undeletable on its now-orphaned patient_id
  -- (P0058). (a2') below keeps patient_id CONSISTENT with the alert's own
  -- test instead of freezing it, and step (c) still asserts old ∪ new
  -- active and takes the lock exclusive when the patient set changes.
  if tg_op = 'UPDATE' then
    if tg_table_name = 'result_amendments' and v_changed && array['result_id', 'test_request_id'] then
      raise exception 'a correction record stays on its result and test — record a new correction instead'
        using errcode = '23514';
    end if;
    if tg_table_name = 'critical_alerts' and v_changed && array['result_id', 'test_request_id'] then
      raise exception 'a critical alert stays on its result and test — record a new alert instead'
        using errcode = '23514';
    end if;
  end if;

  -- (a2') An alert's patient_id must always be the patient who currently
  -- owns its test (via the test's visit) — it follows its test, it does not
  -- roam independently. Checked on INSERT and on every UPDATE (test_request_id
  -- itself can never change per (a2) above, so in practice this only re-runs
  -- when patient_id changes, but checking unconditionally is cheap and needs
  -- no v_changed bookkeeping). This is a consistency check, not an
  -- active-patient check — step (c) below still locks and asserts whichever
  -- patient(s) this resolves to are active.
  if tg_table_name = 'critical_alerts' and tg_op <> 'DELETE'
     and (v_n ->> 'patient_id') is distinct from (
           select v.patient_id::text from public.test_requests tr
             join public.visits v on v.id = tr.visit_id
            where tr.id = (v_n ->> 'test_request_id')::uuid) then
    raise exception 'a critical alert''s patient must match its test''s patient'
      using errcode = '23514';
  end if;

  -- (a3) ON DELETE SET NULL on critical_alerts.withdrawn_by_amendment (0179):
  -- deleting an amendment (directly, or cascading from its result or test)
  -- UPDATEs the alert after the amendment row is gone. That OLD reference can
  -- no longer be resolved. Since the Task 2 fix below always resolves the OLD
  -- row with p_for_delete = true, lifecycle_patients_of_row's own null-strip
  -- (it drops every unresolved reference from the OLD side, not only on a
  -- literal DELETE) ALREADY covers this exact case — a vanished
  -- withdrawn_by_amendment resolves to a NULL element that the generic
  -- p_for_delete pass then strips, same as any other vanished OLD reference.
  -- This block is now belt-and-braces, not the only thing preventing a false
  -- "patient not found": it makes the drop explicit and documented for this
  -- one FK's ON DELETE SET NULL shape, and stays cheap enough to keep even
  -- though the generic mechanism would already produce the same result.
  if tg_op = 'UPDATE' and tg_table_name = 'critical_alerts'
     and v_o ->> 'withdrawn_by_amendment' is not null
     and v_n ->> 'withdrawn_by_amendment' is null
     and not exists (select 1 from public.result_amendments am
                      where am.id = (v_o ->> 'withdrawn_by_amendment')::uuid) then
    v_o := v_o - 'withdrawn_by_amendment';
  end if;

  -- (b) Results family: the membership lock FIRST (see header, step 1).
  if tg_table_name in ('results', 'result_test_requests', 'result_values', 'result_amendments', 'critical_alerts') then
    perform public.lifecycle_lock_results(
      public.lifecycle_result_ids_of_row(tg_table_name, v_o) || public.lifecycle_result_ids_of_row(tg_table_name, v_n),
      tg_table_name = 'result_test_requests' or (tg_table_name = 'results' and tg_op = 'DELETE'));
  end if;

  -- (c) Lock the owning patients, assert, re-resolve. The OLD row always
  -- passes p_for_delete = true (review fix #3, header note above) — not just
  -- on DELETE — so a patient reference that vanished via a hard delete
  -- earlier in this transaction is dropped on the OLD side of an UPDATE too.
  if v_o is not null then
    v_old := public.lifecycle_patients_of_row(tg_table_name, v_o, true);
  end if;
  if v_n is not null then
    v_new := public.lifecycle_patients_of_row(tg_table_name, v_n, false);
  end if;
  v_set := public.lifecycle_norm(v_old || v_new);

  perform public.lifecycle_lock_and_assert(
    v_set,
    tg_op = 'UPDATE' and public.lifecycle_norm(v_old) is distinct from public.lifecycle_norm(v_new));

  v_again := public.lifecycle_norm(
       case when v_o is not null
            then public.lifecycle_patients_of_row(tg_table_name, v_o, true)
            else '{}'::uuid[] end
    || case when v_n is not null
            then public.lifecycle_patients_of_row(tg_table_name, v_n, false)
            else '{}'::uuid[] end);
  if v_again is distinct from v_set then
    raise exception 'the patient on this record changed while it was being saved — try again'
      using errcode = 'P0072';
  end if;

  -- (d) One patient per result (Codex plan review P1-1, "enforce ownership
  -- consistency"): a link may only join a result whose OTHER links belong to
  -- the same patient. Stable under the exclusive membership lock from (b).
  if tg_table_name = 'result_test_requests' and tg_op <> 'DELETE' then
    v_owner := public.lifecycle_norm(array_remove(
                 public.lifecycle_patients_of_result((v_n ->> 'result_id')::uuid,
                   case when tg_op = 'UPDATE' and (v_o ->> 'result_id') = (v_n ->> 'result_id')
                        then (v_o ->> 'test_request_id')::uuid end)
                 || public.lifecycle_patients_of_test_requests(array[(v_n ->> 'test_request_id')::uuid]),
                 null));
    if cardinality(v_owner) > 1 then
      raise exception 'a result can only hold one patient''s tests — create a separate result for this test'
        using errcode = '23514';
    end if;
  end if;
  -- An alert can only be withdrawn by a correction of ITS OWN result (what
  -- result_edit_commit does, 0179) — so the indirect path adds no result.
  if tg_table_name = 'critical_alerts' and tg_op <> 'DELETE'
     and v_n ->> 'withdrawn_by_amendment' is not null
     and not exists (select 1 from public.result_amendments am
                      where am.id = (v_n ->> 'withdrawn_by_amendment')::uuid
                        and am.result_id = (v_n ->> 'result_id')::uuid) then
    raise exception 'an alert can only be withdrawn by a correction of its own result'
      using errcode = '23514';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function public.enforce_patient_activity() from public, anon, authenticated, service_role;

-- Tables whose rows name the patient directly.
drop trigger if exists a_lifecycle_guard on public.visits;
create trigger a_lifecycle_guard
  before insert or update or delete on public.visits
  for each row execute function public.enforce_patient_activity();

drop trigger if exists a_lifecycle_guard on public.appointments;
create trigger a_lifecycle_guard
  before insert or update or delete on public.appointments
  for each row execute function public.enforce_patient_activity();

drop trigger if exists a_lifecycle_guard on public.patient_consents;
create trigger a_lifecycle_guard
  before insert or update or delete on public.patient_consents
  for each row execute function public.enforce_patient_activity();

-- 0167's delete-only attachment guard is folded in: the general guard covers
-- INSERT/UPDATE/DELETE and takes the lock.
drop trigger if exists trg_appointment_attachments_delete_guard on public.appointment_attachments;
drop function if exists public.enforce_appointment_attachment_delete();
drop trigger if exists a_lifecycle_guard on public.appointment_attachments;
create trigger a_lifecycle_guard
  before insert or update or delete on public.appointment_attachments
  for each row execute function public.enforce_patient_activity();

-- Tables that reach the patient through visit_id.
drop trigger if exists a_lifecycle_guard on public.test_requests;
create trigger a_lifecycle_guard
  before insert or update or delete on public.test_requests
  for each row execute function public.enforce_patient_activity();

drop trigger if exists a_lifecycle_guard on public.payments;
create trigger a_lifecycle_guard
  before insert or update or delete on public.payments
  for each row execute function public.enforce_patient_activity();

drop trigger if exists a_lifecycle_guard on public.visit_pins;
create trigger a_lifecycle_guard
  before insert or update or delete on public.visit_pins
  for each row execute function public.enforce_patient_activity();

-- The results family. results has no patient FK (0051): its patients are
-- whoever its result_test_requests rows point at; an unlinked row is inert.
drop trigger if exists a_lifecycle_guard on public.results;
create trigger a_lifecycle_guard
  before insert or update or delete on public.results
  for each row execute function public.enforce_patient_activity();

drop trigger if exists a_lifecycle_guard on public.result_test_requests;
create trigger a_lifecycle_guard
  before insert or update or delete on public.result_test_requests
  for each row execute function public.enforce_patient_activity();

drop trigger if exists a_lifecycle_guard on public.result_values;
create trigger a_lifecycle_guard
  before insert or update or delete on public.result_values
  for each row execute function public.enforce_patient_activity();

drop trigger if exists a_lifecycle_guard on public.result_amendments;
create trigger a_lifecycle_guard
  before insert or update or delete on public.result_amendments
  for each row execute function public.enforce_patient_activity();

drop trigger if exists a_lifecycle_guard on public.critical_alerts;
create trigger a_lifecycle_guard
  before insert or update or delete on public.critical_alerts
  for each row execute function public.enforce_patient_activity();

-- HMO sub-ledger rows and doctor PF entries (via test_request / item / payment).
-- hmo_claim_batches is NOT guarded: a batch holds many patients, and
-- recompute_hmo_batch_status only ever writes batches. A reopen that would
-- un-void an inactive patient's item fails in that item's guard.
drop trigger if exists a_lifecycle_guard on public.hmo_claim_items;
create trigger a_lifecycle_guard
  before insert or update or delete on public.hmo_claim_items
  for each row execute function public.enforce_patient_activity();

drop trigger if exists a_lifecycle_guard on public.hmo_payment_allocations;
create trigger a_lifecycle_guard
  before insert or update or delete on public.hmo_payment_allocations
  for each row execute function public.enforce_patient_activity();

drop trigger if exists a_lifecycle_guard on public.hmo_claim_resolutions;
create trigger a_lifecycle_guard
  before insert or update or delete on public.hmo_claim_resolutions
  for each row execute function public.enforce_patient_activity();

drop trigger if exists a_lifecycle_guard on public.doctor_pf_entries;
create trigger a_lifecycle_guard
  before insert or update or delete on public.doctor_pf_entries
  for each row execute function public.enforce_patient_activity();

-- ---------------------------------------------------------------------------
-- (4) Existing RPCs take the lifecycle lock BEFORE their own row/slot lock.
-- Each body is copied verbatim from its latest migration; the only changes
-- are the lines marked "-- 0184:". NULLs are dropped from the pre-acquired set
-- so each function's own not-found error still wins (its guard triggers still
-- fail closed). After the row lock the set is resolved again: a record that
-- moved to another patient while we waited raises P0072 (retry once).
-- ---------------------------------------------------------------------------

-- (4a) result_save_draft — copied verbatim from 0172_result_edit_commit.sql
-- lines 571-615.
create or replace function public.result_save_draft(
  p_result_id uuid,
  p_values    jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result public.results%rowtype;
  v_patients uuid[];  -- 0184
begin
  -- 0184: the result-membership lock (shared), then the patient lifecycle
  -- lock, before the result row lock.
  perform public.lifecycle_lock_results(array[p_result_id], false);
  v_patients := public.lifecycle_norm(array_remove(public.lifecycle_patients_of_result(p_result_id), null));
  perform public.lifecycle_lock_and_assert(v_patients, false);

  select * into v_result
    from public.results
   where id = p_result_id
   for update;
  if not found then
    raise exception 'result not found' using errcode = 'P0066';
  end if;
  -- 0184: the result's patients must still be the ones we locked.
  if public.lifecycle_norm(array_remove(public.lifecycle_patients_of_result(p_result_id), null))
       is distinct from v_patients then
    raise exception 'the patient on this result changed while it was being saved — try again'
      using errcode = 'P0072';
  end if;
  if v_result.generation_kind <> 'structured' or v_result.finalised_at is not null then
    raise exception 'this result is already finalised — use Edit results to change it'
      using errcode = 'P0066';
  end if;

  insert into public.result_values (
    result_id, parameter_id, numeric_value_si, numeric_value_conv,
    text_value, select_value, flag, is_blank
  )
  select p_result_id, x.parameter_id, x.numeric_value_si, x.numeric_value_conv,
         x.text_value, x.select_value, x.flag, coalesce(x.is_blank, false)
    from jsonb_to_recordset(coalesce(p_values, '[]'::jsonb)) as x(
      parameter_id uuid, numeric_value_si numeric, numeric_value_conv numeric,
      text_value text, select_value text, flag text, is_blank boolean
    )
  on conflict (result_id, parameter_id) do update
     set numeric_value_si   = excluded.numeric_value_si,
         numeric_value_conv = excluded.numeric_value_conv,
         text_value         = excluded.text_value,
         select_value       = excluded.select_value,
         flag               = excluded.flag,
         is_blank           = excluded.is_blank;
end;
$$;
revoke all on function public.result_save_draft(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.result_save_draft(uuid, jsonb) to service_role;

-- (4b) result_finalise_commit — copied verbatim from 0172_result_edit_commit.sql
-- lines 437-568.
create or replace function public.result_finalise_commit(
  p_result_id       uuid,
  p_finaliser       uuid,
  p_values          jsonb,        -- the COMPLETE value set the PDF was rendered from
  p_storage_path    text,
  p_file_size_bytes int,
  p_finalised_at    timestamptz,  -- the instant printed on the PDF
  p_new_image       jsonb,        -- null = no image (non-imaging layouts)
  p_alerts          jsonb         -- crossings of p_values; '[]' = none
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result     public.results%rowtype;
  v_live       int;
  v_bad        int;
  v_patient_id uuid;
  v_drm_id     text;
  v_added      jsonb := '[]'::jsonb;
  v_patients   uuid[];  -- 0184
begin
  -- 0184: the result-membership lock (shared), then the patient lifecycle
  -- lock, before the result row lock.
  perform public.lifecycle_lock_results(array[p_result_id], false);
  v_patients := public.lifecycle_norm(array_remove(public.lifecycle_patients_of_result(p_result_id), null));
  perform public.lifecycle_lock_and_assert(v_patients, false);

  select * into v_result
    from public.results
   where id = p_result_id
   for update;
  if not found then
    raise exception 'result not found' using errcode = 'P0066';
  end if;
  -- 0184: the result's patients must still be the ones we locked.
  if public.lifecycle_norm(array_remove(public.lifecycle_patients_of_result(p_result_id), null))
       is distinct from v_patients then
    raise exception 'the patient on this result changed while it was being saved — try again'
      using errcode = 'P0072';
  end if;
  if v_result.generation_kind <> 'structured' then
    raise exception 'this result was uploaded as a PDF' using errcode = 'P0066';
  end if;
  if v_result.finalised_at is not null then
    raise exception 'this result is already finalised — use Edit results to change it'
      using errcode = 'P0066';
  end if;

  select count(*),
         count(*) filter (where tr.status not in ('in_progress', 'result_uploaded'))
    into v_live, v_bad
    from public.result_test_requests rtr
    join public.test_requests tr on tr.id = rtr.test_request_id
    join public.visits v on v.id = tr.visit_id
   where rtr.result_id = p_result_id
     and tr.deleted_at is null
     and v.deleted_at is null;
  if v_live = 0 then
    raise exception 'no live test is linked to this result' using errcode = 'P0066';
  end if;
  if v_bad > 0 then
    raise exception 'a test on this result is not in progress' using errcode = 'P0066';
  end if;

  select v.patient_id, p.drm_id
    into v_patient_id, v_drm_id
    from public.result_test_requests rtr
    join public.test_requests tr on tr.id = rtr.test_request_id
    join public.visits v on v.id = tr.visit_id
    join public.patients p on p.id = v.patient_id
   where rtr.result_id = p_result_id
   limit 1;

  delete from public.result_values where result_id = p_result_id;
  insert into public.result_values (
    result_id, parameter_id, numeric_value_si, numeric_value_conv,
    text_value, select_value, flag, is_blank
  )
  select p_result_id, x.parameter_id, x.numeric_value_si, x.numeric_value_conv,
         x.text_value, x.select_value, x.flag, coalesce(x.is_blank, false)
    from jsonb_to_recordset(coalesce(p_values, '[]'::jsonb)) as x(
      parameter_id uuid, numeric_value_si numeric, numeric_value_conv numeric,
      text_value text, select_value text, flag text, is_blank boolean
    );

  update public.results
     set storage_path       = p_storage_path,
         file_size_bytes    = p_file_size_bytes,
         finalised_at       = p_finalised_at,
         uploaded_by        = p_finaliser,
         uploaded_at        = now(),
         image_storage_path = case when p_new_image is null then image_storage_path
                                   else p_new_image->>'storage_path' end,
         image_filename     = case when p_new_image is null then image_filename
                                   else p_new_image->>'filename' end,
         image_mime_type    = case when p_new_image is null then image_mime_type
                                   else p_new_image->>'mime_type' end,
         image_size_bytes   = case when p_new_image is null then image_size_bytes
                                   else (p_new_image->>'size_bytes')::int end,
         image_uploaded_at  = case when p_new_image is null then image_uploaded_at
                                   else now() end,
         image_uploaded_by  = case when p_new_image is null then image_uploaded_by
                                   else p_finaliser end
   where id = p_result_id;

  -- A result is finalised once, so there should be no alerts yet. Any left by
  -- a pre-0172 attempt are cleared unless acknowledged (never touched).
  delete from public.critical_alerts
   where result_id = p_result_id
     and acknowledged_at is null;

  with ins as (
    insert into public.critical_alerts (
      result_id, test_request_id, parameter_id, parameter_name, direction,
      observed_value_si, threshold_si, patient_id, patient_drm_id
    )
    select p_result_id, d.test_request_id, d.parameter_id, d.parameter_name,
           d.direction, d.observed_value_si, d.threshold_si, v_patient_id, v_drm_id
      from jsonb_to_recordset(coalesce(p_alerts, '[]'::jsonb)) as d(
        test_request_id uuid, parameter_id uuid, parameter_name text,
        direction text, observed_value_si numeric, threshold_si numeric
      )
     where not exists (
       select 1 from public.critical_alerts ca
        where ca.result_id = p_result_id
          and ca.parameter_id = d.parameter_id
          and ca.direction = d.direction
          and ca.observed_value_si is not distinct from d.observed_value_si
     )
    returning parameter_name, direction, observed_value_si, threshold_si
  )
  select coalesce(jsonb_agg(to_jsonb(ins)), '[]'::jsonb) into v_added from ins;

  return jsonb_build_object('alerts_added', v_added);
end;
$$;
revoke all on function public.result_finalise_commit(
  uuid, uuid, jsonb, text, int, timestamptz, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.result_finalise_commit(
  uuid, uuid, jsonb, text, int, timestamptz, jsonb, jsonb
) to service_role;

-- (4c) result_edit_commit — copied verbatim from 0179_result_copy_followups.sql
-- (0176's body plus three "-- 0179" hunks, merged #239); the create statement
-- through its closing "$$;" and its revoke/grant. The three "-- 0179" hunks
-- are kept byte-for-byte.
create or replace function public.result_edit_commit(
  p_attempt_id               uuid,
  p_result_id                uuid,
  p_expected_amendment_count int,
  p_editor                   uuid,
  p_reason                   text,
  p_anchor_test_request_id   uuid,
  p_new_storage_path         text,
  p_new_file_size_bytes      int,
  p_values                   jsonb,  -- null = PDF-only edit, values untouched
  p_new_image                jsonb,  -- null = keep the current image columns
  p_alerts                   jsonb   -- null = leave critical_alerts alone
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing    public.result_amendments%rowtype;
  v_result      public.results%rowtype;
  v_seq         int;
  v_reason      text := btrim(coalesce(p_reason, ''));
  v_live        int;
  v_unfinished  int;
  v_patient_id  uuid;
  v_drm_id      text;
  v_snapshot    jsonb;
  v_amend_id    uuid;
  v_added       jsonb := '[]'::jsonb;
  v_removed     int := 0;
  v_kept_ack    int := 0;
  v_patients    uuid[];  -- 0184
  v_replay_first boolean;  -- 0184
begin
  -- 0184: a replay of an attempt that already committed writes nothing, so it
  -- must still answer after the patient was deleted (the app would otherwise
  -- treat the rejection as final and remove the committed PDF). Only a NEW
  -- attempt takes the lifecycle lock — before the result row lock.
  v_replay_first := exists (select 1 from public.result_amendments a where a.attempt_id = p_attempt_id);
  if not v_replay_first then
    perform public.lifecycle_lock_results(array[p_result_id], false);
    v_patients := public.lifecycle_norm(array_remove(public.lifecycle_patients_of_result(p_result_id), null));
    perform public.lifecycle_lock_and_assert(v_patients, false);
  end if;

  -- 1) Serialise every edit, draft and finalise of this result on its row.
  select * into v_result
    from public.results
   where id = p_result_id
   for update;
  if not found then
    raise exception 'result not found' using errcode = 'P0066';
  end if;

  -- 2) Replay: this attempt already committed (the app lost the response and
  --    asked again). Checked UNDER the lock, so two overlapping calls with one
  --    attempt id cannot both pass — the second waits, then finds the first
  --    committed and returns it instead of failing the stale check below.
  select * into v_existing
    from public.result_amendments
   where attempt_id = p_attempt_id;
  if found then
    if v_existing.result_id <> p_result_id then
      raise exception 'this edit attempt belongs to another result' using errcode = 'P0066';
    end if;
    -- 0176: answer with what the original attempt DID to critical alerts
    -- (recorded below), so a retried or probed commit still audits every
    -- alert it added and withdrew. Rows from before 0176 have no record.
    return coalesce(
             v_existing.commit_outcome,
             jsonb_build_object('alerts_added', '[]'::jsonb, 'alerts_removed', 0,
                                'alerts_kept_acknowledged', 0, 'outcome_unknown', true)
           )
           || jsonb_build_object(
                'replayed', true,
                'amendment_id', v_existing.id,
                'amendment_seq', v_existing.amendment_seq,
                'prior_storage_path', v_existing.prior_storage_path
              );
  end if;

  -- 0184: the pre-check saw a committed attempt, but it is gone now (its
  -- result was deleted in between). Nothing to replay and no lock was taken.
  if v_replay_first then
    raise exception 'this edit could not be confirmed — reload the result to check it'
      using errcode = 'P0066';
  end if;
  if public.lifecycle_norm(array_remove(public.lifecycle_patients_of_result(p_result_id), null))
       is distinct from v_patients then
    raise exception 'the patient on this result changed while it was being saved — try again'
      using errcode = 'P0072';
  end if;

  -- 3) Editable?
  if v_result.storage_path is null then
    raise exception 'this result has no finished PDF yet' using errcode = 'P0066';
  end if;
  if v_result.generation_kind = 'structured' and v_result.finalised_at is null then
    raise exception 'this result has not been finalised yet' using errcode = 'P0066';
  end if;
  if length(v_reason) < 5 or length(v_reason) > 2000 then
    raise exception 'the reason must be 5 to 2000 characters' using errcode = 'P0066';
  end if;

  select count(*),
         count(*) filter (
           where tr.status not in ('result_uploaded', 'ready_for_release', 'released')
         )
    into v_live, v_unfinished
    from public.result_test_requests rtr
    join public.test_requests tr on tr.id = rtr.test_request_id
    join public.visits v on v.id = tr.visit_id
   where rtr.result_id = p_result_id
     and tr.deleted_at is null
     and v.deleted_at is null;
  if v_live = 0 then
    raise exception 'every test on this result was deleted' using errcode = 'P0066';
  end if;
  if v_unfinished > 0 then
    raise exception 'a test on this result is not finished' using errcode = 'P0066';
  end if;

  select v.patient_id, p.drm_id
    into v_patient_id, v_drm_id
    from public.result_test_requests rtr
    join public.test_requests tr on tr.id = rtr.test_request_id
    join public.visits v on v.id = tr.visit_id
    join public.patients p on p.id = v.patient_id
   where rtr.result_id = p_result_id
     and rtr.test_request_id = p_anchor_test_request_id
     and tr.deleted_at is null
     and v.deleted_at is null;
  if not found then
    raise exception 'the anchor test is not a live test on this result' using errcode = 'P0066';
  end if;

  -- 4) Stale form: someone saved an edit since this one was opened.
  if v_result.amendment_count <> p_expected_amendment_count then
    raise exception 'this result was edited by someone else since you opened it'
      using errcode = 'P0065';
  end if;
  v_seq := p_expected_amendment_count + 1;

  -- 5) Snapshot, taken under the same lock as the overwrite.
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'parameter_id', rv.parameter_id,
               'parameter_name', rtp.parameter_name,
               'numeric_value_si', rv.numeric_value_si,
               'numeric_value_conv', rv.numeric_value_conv,
               'text_value', rv.text_value,
               'select_value', rv.select_value,
               'flag', rv.flag,
               'is_blank', rv.is_blank
             )
             order by rtp.sort_order, rv.parameter_id
           ),
           '[]'::jsonb
         )
    into v_snapshot
    from public.result_values rv
    left join public.result_template_params rtp on rtp.id = rv.parameter_id
   where rv.result_id = p_result_id;

  insert into public.result_amendments (
    result_id, test_request_id,
    prior_storage_path, prior_uploaded_by, prior_uploaded_at,
    prior_file_size_bytes, prior_notes,
    prior_values_json,
    prior_image_storage_path, prior_image_filename,
    prior_image_mime_type, prior_image_size_bytes,
    reason, amended_by, amendment_seq, attempt_id
  ) values (
    p_result_id, p_anchor_test_request_id,
    v_result.storage_path, v_result.uploaded_by, v_result.uploaded_at,
    v_result.file_size_bytes, v_result.notes,
    case when v_result.generation_kind = 'structured' then v_snapshot else null end,
    v_result.image_storage_path, v_result.image_filename,
    v_result.image_mime_type, v_result.image_size_bytes,
    v_reason, p_editor, v_seq, p_attempt_id
  )
  returning id into v_amend_id;

  -- 6) New values (flags were computed in TypeScript — 0010).
  if p_values is not null then
    delete from public.result_values where result_id = p_result_id;
    insert into public.result_values (
      result_id, parameter_id, numeric_value_si, numeric_value_conv,
      text_value, select_value, flag, is_blank
    )
    select p_result_id, x.parameter_id, x.numeric_value_si, x.numeric_value_conv,
           x.text_value, x.select_value, x.flag, coalesce(x.is_blank, false)
      from jsonb_to_recordset(p_values) as x(
        parameter_id uuid, numeric_value_si numeric, numeric_value_conv numeric,
        text_value text, select_value text, flag text, is_blank boolean
      );
  end if;

  -- 7) Point the result at the new PDF. finalised_at is untouched, so
  --    advance_test_on_result_upload cannot fire, and test_requests is never
  --    written here.
  update public.results
     set storage_path       = p_new_storage_path,
         file_size_bytes    = p_new_file_size_bytes,
         uploaded_by        = p_editor,
         uploaded_at        = now(),
         amended_at         = now(),
         amendment_count    = v_seq,
         image_storage_path = case when p_new_image is null then image_storage_path
                                   else p_new_image->>'storage_path' end,
         image_filename     = case when p_new_image is null then image_filename
                                   else p_new_image->>'filename' end,
         image_mime_type    = case when p_new_image is null then image_mime_type
                                   else p_new_image->>'mime_type' end,
         image_size_bytes   = case when p_new_image is null then image_size_bytes
                                   else (p_new_image->>'size_bytes')::int end,
         image_uploaded_at  = case when p_new_image is null then image_uploaded_at
                                   else now() end,
         image_uploaded_by  = case when p_new_image is null then image_uploaded_by
                                   else p_editor end
   where id = p_result_id;

  -- 8) Critical alerts. Identity = (parameter_id, direction, observed value).
  --    Lock this result's alerts first so an acknowledgement in flight either
  --    lands before (and is then kept) or waits for this commit.
  if p_alerts is not null then
    perform 1 from public.critical_alerts where result_id = p_result_id for update;

    with desired as (
      select x.test_request_id, x.parameter_id, x.parameter_name, x.direction,
             x.observed_value_si, x.threshold_si
        from jsonb_to_recordset(p_alerts) as x(
          test_request_id uuid, parameter_id uuid, parameter_name text,
          direction text, observed_value_si numeric, threshold_si numeric
        )
    ),
    ins as (
      insert into public.critical_alerts (
        result_id, test_request_id, parameter_id, parameter_name, direction,
        observed_value_si, threshold_si, patient_id, patient_drm_id
      )
      select p_result_id, d.test_request_id, d.parameter_id, d.parameter_name,
             d.direction, d.observed_value_si, d.threshold_si, v_patient_id, v_drm_id
        from desired d
       where not exists (
         select 1 from public.critical_alerts ca
          where ca.result_id = p_result_id
            and ca.parameter_id = d.parameter_id
            and ca.direction = d.direction
            and ca.observed_value_si is not distinct from d.observed_value_si
            -- 0179: a withdrawn alert is history, not a live match — a value
            -- corrected back to it pages again.
            and ca.withdrawn_at is null
       )
      returning parameter_name, direction, observed_value_si, threshold_si
    )
    select coalesce(jsonb_agg(to_jsonb(ins)), '[]'::jsonb) into v_added from ins;

    -- 0179: a removed alert is WITHDRAWN (kept as history), never deleted.
    with gone as (
      update public.critical_alerts ca
         set withdrawn_at = now(),
             withdrawn_by = p_editor,
             withdrawn_by_amendment = v_amend_id
       where ca.result_id = p_result_id
         and ca.acknowledged_at is null
         and ca.withdrawn_at is null
         and not exists (
           select 1
             from jsonb_to_recordset(p_alerts) as d(
               parameter_id uuid, direction text, observed_value_si numeric
             )
            where d.parameter_id = ca.parameter_id
              and d.direction = ca.direction
              and d.observed_value_si is not distinct from ca.observed_value_si
         )
      returning 1
    )
    select count(*) into v_removed from gone;

    select count(*) into v_kept_ack
      from public.critical_alerts
     where result_id = p_result_id
       and acknowledged_at is not null
       and withdrawn_at is null; -- 0179
  end if;

  -- 0176: keep this attempt's alert outcome on its amendment row, in the
  -- same transaction, for a replay or a lost-response probe to report.
  update public.result_amendments
     set commit_outcome = jsonb_build_object(
           'alerts_added', v_added,
           'alerts_removed', v_removed,
           'alerts_kept_acknowledged', v_kept_ack
         )
   where id = v_amend_id;

  return jsonb_build_object(
    'replayed', false,
    'amendment_id', v_amend_id,
    'amendment_seq', v_seq,
    'prior_storage_path', v_result.storage_path,
    'alerts_added', v_added,
    'alerts_removed', v_removed,
    'alerts_kept_acknowledged', v_kept_ack
  );
end;
$$;

revoke all on function public.result_edit_commit(
  uuid, uuid, int, uuid, text, uuid, text, int, jsonb, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.result_edit_commit(
  uuid, uuid, int, uuid, text, uuid, text, int, jsonb, jsonb, jsonb
) to service_role;

-- (4d) correct_payment — copied verbatim from 0183_waived_balance_gl.sql lines
-- 1198-1391 (controller correction: 0183, not 0174 as the plan text names —
-- 0183 merged #242 on 2026-09-28 and re-creates this function from 0174's
-- stale-guard body plus the waived-visit rule; 0184 copies 0183's body).
create or replace function public.correct_payment(
  p_payment_id       uuid,
  p_amount_php       numeric,
  p_method           text,
  p_reference_number text,
  p_notes            text,
  p_reason           text,
  p_actor_id         uuid,
  p_visit_id         uuid default null,
  p_expected         jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old    public.payments%rowtype;
  v_new_id uuid;
  v_target uuid;
  v_moving boolean;
  v_ref    text := nullif(btrim(coalesce(p_reference_number, '')), '');
  v_notes  text := nullif(btrim(coalesce(p_notes, '')), '');
  v_src_status text;
  v_tgt_status text;
  r_v          record;
  v_patients   uuid[];  -- 0184
begin
  if p_actor_id is null then
    raise exception 'Edit payment needs the staff member making the change.'
      using errcode = 'P0054';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A reason is required to edit a payment.'
      using errcode = 'P0054';
  end if;

  -- 0184: lifecycle locks — the payment's patient and, for a move, the target
  -- visit's — before the payment row lock.
  v_patients := public.lifecycle_norm(array_remove(
                  public.lifecycle_patients_of_payments(array[p_payment_id])
                  || case when p_visit_id is null then '{}'::uuid[]
                          else public.lifecycle_patients_of_visits(array[p_visit_id]) end,
                  null));
  perform public.lifecycle_lock_and_assert(v_patients, false);

  select * into v_old
    from public.payments
   where id = p_payment_id
   for update;

  if not found then
    raise exception 'Payment not found.' using errcode = 'P0054';
  end if;
  if v_old.voided_at is not null then
    raise exception 'This payment was already deleted or edited. Refresh the visit and try again.'
      using errcode = 'P0054';
  end if;
  -- 0184: still the same patients?
  if public.lifecycle_norm(array_remove(
       public.lifecycle_patients_of_payments(array[p_payment_id])
       || case when p_visit_id is null then '{}'::uuid[]
               else public.lifecycle_patients_of_visits(array[p_visit_id]) end,
       null)) is distinct from v_patients then
    raise exception 'the patient on this payment changed while it was being saved — try again'
      using errcode = 'P0072';
  end if;

  -- What the caller saw must still be what is there. Text fields compare the
  -- way they are stored (trimmed, '' = NULL); a key the caller left out is
  -- not checked.
  if p_expected is not null and (
       (p_expected ? 'amount_php'
          and v_old.amount_php is distinct from (p_expected->>'amount_php')::numeric)
    or (p_expected ? 'method'
          and v_old.method is distinct from (p_expected->>'method'))
    or (p_expected ? 'visit_id'
          and v_old.visit_id is distinct from (p_expected->>'visit_id')::uuid)
    or (p_expected ? 'reference_number'
          and v_old.reference_number is distinct from
              nullif(btrim(coalesce(p_expected->>'reference_number', '')), ''))
    or (p_expected ? 'notes'
          and v_old.notes is distinct from
              nullif(btrim(coalesce(p_expected->>'notes', '')), ''))
  ) then
    raise exception 'Someone else changed this payment since you opened it. Refresh the visit and try again.'
      using errcode = 'P0054';
  end if;

  if v_old.method in ('gift_code', 'hmo')
     or exists (select 1 from public.gift_codes where redeemed_payment_id = v_old.id) then
    raise exception 'Gift code and HMO payments cannot be edited. Delete it and record it again.'
      using errcode = 'P0054';
  end if;
  if v_old.legacy_import_run_id is not null then
    raise exception 'Payments from the imported history cannot be edited. Delete it and record it again.'
      using errcode = 'P0054';
  end if;
  -- The method is only checked when it CHANGES: a Move (or a reference fix)
  -- re-sends the payment's own method, and a legacy bpi / maybank receipt
  -- must stay what it was rather than be refused for a method the counter no
  -- longer offers. A new method must be one the counter records today.
  if p_method is null
     or (p_method is distinct from v_old.method
         and p_method not in ('cash', 'gcash', 'maya', 'card', 'bank_transfer')) then
    raise exception 'Choose Cash, GCash, Maya, Card or Bank transfer.'
      using errcode = 'P0054';
  end if;
  if p_amount_php is null or p_amount_php <= 0 then
    raise exception 'Amount must be greater than zero.' using errcode = 'P0054';
  end if;
  if round(p_amount_php, 2) <> p_amount_php then
    raise exception 'Amount can have at most two decimal places.' using errcode = 'P0054';
  end if;
  if p_amount_php > 99999999.99 then
    raise exception 'Amount is too large.' using errcode = 'P0054';
  end if;

  v_target := coalesce(p_visit_id, v_old.visit_id);
  v_moving := v_target <> v_old.visit_id;
  if v_moving then
    if not exists (select 1 from public.visits where id = v_target) then
      raise exception 'Visit not found.' using errcode = 'P0054';
    end if;
    if exists (select 1 from public.visits where id = v_target and deleted_at is not null) then
      raise exception 'That visit was deleted from the queue. Restore it before moving a payment onto it.'
        using errcode = 'P0054';
    end if;
  end if;

  -- 0183: a waived visit's money is fixed. Lock order payment → visits
  -- in uuid order (source and target both), the same order as
  -- guard_payment_on_waived_visit, so two opposite-direction moves
  -- cannot cycle.
  for r_v in
    select id, payment_status from public.visits
     where id in (v_old.visit_id, coalesce(v_target, v_old.visit_id))
     order by id for update
  loop
    if r_v.id = v_old.visit_id then v_src_status := r_v.payment_status; end if;
    if v_moving and r_v.id = v_target then v_tgt_status := r_v.payment_status; end if;
  end loop;
  if v_moving and v_tgt_status = 'waived' then
    raise exception 'That visit''s balance was waived, so no payment can be moved onto it.' using errcode = 'P0070';
  end if;
  if v_src_status = 'waived' then
    if v_moving then
      raise exception 'This visit''s balance was waived, so its payments cannot be moved.' using errcode = 'P0070';
    end if;
    if p_amount_php <> v_old.amount_php then
      raise exception 'This visit''s balance was waived, so the amount is fixed. Change only the method, reference or notes.'
        using errcode = 'P0070';
    end if;
  end if;

  -- Reference / notes only: not a money change, edit in place.
  if not v_moving and p_amount_php = v_old.amount_php and p_method = v_old.method then
    if v_ref is not distinct from v_old.reference_number
       and v_notes is not distinct from v_old.notes then
      raise exception 'Nothing changed.' using errcode = 'P0054';
    end if;
    update public.payments
       set reference_number = v_ref,
           notes            = v_notes
     where id = p_payment_id;
    return p_payment_id;
  end if;

  -- Money change or move: re-create, then void. See 0161's header for the order.
  if v_src_status = 'waived' then
    perform set_config('app.waived_visit_edit', 'on', true);
  end if;
  insert into public.payments (
    visit_id, amount_php, method, reference_number, notes,
    received_by, received_at, corrects_payment_id
  ) values (
    v_target, p_amount_php, p_method, v_ref, v_notes,
    v_old.received_by, v_old.received_at, v_old.id
  )
  returning id into v_new_id;

  update public.payments
     set voided_at   = now(),
         voided_by   = p_actor_id,
         void_reason = case when v_moving then 'Moved: ' else 'Edited: ' end || btrim(p_reason)
   where id = p_payment_id;
  perform set_config('app.waived_visit_edit', 'off', true);

  return v_new_id;
end;
$$;

comment on function public.correct_payment(uuid, numeric, text, text, text, text, uuid, uuid, jsonb) is
  'Edit / Move a payment (0161, stale guard 0174, waived-visit rule 0183): re-create then void in one transaction; reference/notes-only edits in place. On a waived visit only an equal-amount replacement is allowed (P0070). p_expected = the payment as the caller saw it; any difference is refused (P0054).';

revoke execute on function public.correct_payment(uuid, numeric, text, text, text, text, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant  execute on function public.correct_payment(uuid, numeric, text, text, text, text, uuid, uuid, jsonb)
  to service_role;

-- (4e) appointments_insert_slot_guarded — copied verbatim from
-- 0154_website_messages_inbox.sql lines 213-276.
create or replace function public.appointments_insert_slot_guarded(
  p_rows jsonb,
  p_physician_id uuid default null,    -- null ⇒ no slot guard, plain insert
  p_scheduled_at timestamptz default null,
  p_allow_concurrent boolean default false
)
returns setof uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing int;
  r jsonb;
  v_id uuid;
begin
  -- 0184: every named patient's lifecycle lock (shared, sorted) BEFORE the slot
  -- lock, refusing an inactive patient before anything is inserted. A walk-in
  -- row (no patient_id) names nobody.
  perform public.lifecycle_lock_and_assert(
    array(select distinct nullif(e.elem ->> 'patient_id', '')::uuid
            from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as e(elem)
           where nullif(e.elem ->> 'patient_id', '') is not null),
    false);

  if p_physician_id is not null and p_scheduled_at is not null then
    perform pg_advisory_xact_lock(
      hashtext('appt_slot:' || p_physician_id::text || ':' || p_scheduled_at::text)
    );
    if not p_allow_concurrent then
      select count(*) into v_existing
        from public.appointments
       where physician_id = p_physician_id
         and scheduled_at = p_scheduled_at
         and status not in ('cancelled','no_show');
      if v_existing > 0 then
        raise exception 'slot_taken: that slot was just taken'
          using errcode = 'P0040';
      end if;
    end if;
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    insert into public.appointments (
      patient_id, service_id, physician_id, scheduled_at, notes, status,
      booking_group_id, home_service_requested, walk_in_name, walk_in_phone, created_by,
      source, attribution
    ) values (
      nullif(r->>'patient_id','')::uuid,
      nullif(r->>'service_id','')::uuid,
      nullif(r->>'physician_id','')::uuid,
      nullif(r->>'scheduled_at','')::timestamptz,
      nullif(r->>'notes',''),
      r->>'status',
      nullif(r->>'booking_group_id','')::uuid,
      coalesce((r->>'home_service_requested')::boolean, false),
      nullif(r->>'walk_in_name',''),
      nullif(r->>'walk_in_phone',''),
      nullif(r->>'created_by','')::uuid,
      nullif(r->>'source',''),
      case when jsonb_typeof(r->'attribution') = 'object' then r->'attribution' end
    ) returning id into v_id;
    return next v_id;
  end loop;
end;
$$;

-- As 0112 + 0113 left it: service_role only. Hosted Supabase grants anon and
-- authenticated directly, so revoking from PUBLIC alone is not enough.
revoke all on function public.appointments_insert_slot_guarded(jsonb, uuid, timestamptz, boolean)
  from public, anon, authenticated;
grant execute on function public.appointments_insert_slot_guarded(jsonb, uuid, timestamptz, boolean)
  to service_role;

-- (4f) recompute_clinic_fee_for_unreleased — copied VERBATIM from
-- 0136_physician_compensation_table.sql lines 136-175 (confirmed the latest
-- DEFINER by `grep -ln "function public.recompute_clinic_fee_for_unreleased"
-- supabase/migrations/*.sql`: 0180_posted_lookup_comments.sql also names it,
-- but only for a `comment on function` — it does not re-create the body, so
-- 0136 still owns the definition). The only change is the active-patient
-- join/filter marked "-- 0184:" below.
--
-- This is a bulk, ALL-PATIENTS scrub (`admin/accounting/physicians-compensation.ts:62`
-- calls it with no patient argument at all), unlike every other function in
-- section (4) above, which locks and asserts ONE record's patient before its
-- own row lock. A lock buys nothing here: the function doesn't know which
-- patients it will touch until the CTE runs, and taking every patient's lock
-- up front would mean locking the whole table. Instead, a single inactive
-- patient's otherwise-eligible line used to abort the WHOLE UPDATE with
-- P0058 (test_requests' a_lifecycle_guard, installed by this same migration
-- in section (3)) — one bad row silently left every OTHER doctor's eligible
-- line un-scrubbed too, on every run, until the offending patient was
-- restored or its line stopped qualifying. The fix filters that patient's
-- line OUT of the target set instead: this scrub only ever zeroes
-- `clinic_fee_php` on lines that are not yet posted to the GL (the `not
-- exists (... journal_entries ...)` clause, unchanged from 0136), so a
-- deleted/merged patient's line was never going to book real money here —
-- there is no live consultation fee this run is "letting slip"; the guard's
-- job (stop NEW work/money on an inactive patient) is satisfied by leaving
-- that line exactly as it already was.
create or replace function public.recompute_clinic_fee_for_unreleased()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_affected int;
begin
  with target_ids as (
    select tr.id
    from public.test_requests tr
    join public.visits v on v.id = tr.visit_id
    join public.patients pt on pt.id = v.patient_id   -- 0184: only an active patient's line
    left join public.physicians p
      on p.id = coalesce(tr.attending_physician_id, v.attending_physician_id)
    left join public.physician_compensation pc on pc.physician_id = p.id
    where coalesce(
            pc.clinic_cut_php,
            case when pc.compensation_arrangement in ('rent_paying', 'shareholder') then 0 else 100 end
          ) = 0
      and tr.clinic_fee_php > 0
      and pt.deleted_at is null and pt.merged_into_id is null   -- 0184
      and not exists (
        select 1 from public.journal_entries je
        where je.source_kind = 'test_request'
          and je.source_id = tr.id
          and je.status = 'posted'
      )
  ),
  updated as (
    update public.test_requests tr2
      set clinic_fee_php = 0,
          doctor_pf_php = tr2.final_price_php
      where tr2.id in (select id from target_ids)
      returning tr2.id
  )
  select count(*) into v_affected from updated;

  return jsonb_build_object('rows_affected', v_affected);
end;
$function$;

-- ACL restated exactly as 0118 left it (0136's `create or replace` did not
-- touch grants, and local `proacl` confirms it: {postgres=X/postgres,
-- service_role=X/postgres} — no anon/authenticated). service_role only.
revoke all on function public.recompute_clinic_fee_for_unreleased() from public, anon, authenticated;
grant execute on function public.recompute_clinic_fee_for_unreleased() to service_role;

-- ---------------------------------------------------------------------------
-- (5) resolve_patient_guarded — 0167's body (lines 901-944) plus:
--   * last name matched case-insensitively (owner, 2026-09-25; prod had zero
--     active case-variant groups). The identity lock key already lowercased.
--   * the OLDEST active candidate (created_at, id), deterministic.
--   * the candidate's lifecycle lock (shared) and a fresh re-read of activity
--     AND the triple; if either changed while we waited → P0072, and the app
--     retries once in a fresh transaction (never a second lifecycle lock here:
--     a new candidate's key may sort below one already held).
--   * search_path '' and app.referral_origin = 'patient' around the insert —
--     a superset of 0170 (sheet-sync), so either may land first.
-- The identity advisory lock stays FIRST with the key unchanged since 0158.
-- Delete/restore never take identity locks, so this order cannot invert.
-- ---------------------------------------------------------------------------
create or replace function public.resolve_patient_guarded(
  p_email text, p_last_name text, p_birthdate date, p_fields jsonb
)
returns table (id uuid, drm_id text, reused boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
begin
  perform pg_advisory_xact_lock(
    hashtext('patient_resolve:' || lower(p_email) || ':' || lower(p_last_name) || ':' || p_birthdate::text)
  );
  select p.id, p.drm_id into v
    from public.patients p
   where p.email = lower(p_email)
     and lower(p.last_name) = lower(p_last_name)
     and p.birthdate = p_birthdate
     and p.deleted_at is null
     and p.merged_into_id is null
   order by p.created_at, p.id
   limit 1;
  if found then
    perform public.lifecycle_lock(array[v.id], false);
    perform 1
      from public.patients p
     where p.id = v.id
       and p.email = lower(p_email)
       and lower(p.last_name) = lower(p_last_name)
       and p.birthdate = p_birthdate
       and p.deleted_at is null
       and p.merged_into_id is null;
    if not found then
      raise exception 'this patient record changed while the booking was being saved — try again'
        using errcode = 'P0072';
    end if;
    return query select v.id, v.drm_id, true;
    return;
  end if;
  perform pg_catalog.set_config('app.referral_origin', 'patient', true);
  return query
  insert into public.patients (
    first_name, last_name, middle_name, birthdate, sex, phone, email, address, pre_registered,
    referral_source
  ) values (
    p_fields->>'first_name', p_fields->>'last_name', nullif(p_fields->>'middle_name',''),
    (p_fields->>'birthdate')::date,
    nullif(p_fields->>'sex',''),
    nullif(p_fields->>'phone',''), lower(p_email), nullif(p_fields->>'address',''),
    true,
    (select rs.id from public.referral_sources rs where rs.id = nullif(p_fields->>'referral_source',''))
  ) returning patients.id, patients.drm_id, false;
  perform pg_catalog.set_config('app.referral_origin', '', true);
end;
$$;

revoke all on function public.resolve_patient_guarded(text, text, date, jsonb) from public;
revoke execute on function public.resolve_patient_guarded(text, text, date, jsonb) from anon, authenticated;
grant execute on function public.resolve_patient_guarded(text, text, date, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- (6) create_visit_encounter — one transaction for what visits/new/actions.ts
-- did in 3-5 PostgREST calls plus a compensating delete: the visit(s) (two
-- sharing visit_group_id when the order has doctor AND lab lines), every
-- test_requests row (headers and standalone lines first, then package
-- components — tg_test_request_parent_is_header, 0040), one visit_pins row per
-- visit carrying the SAME bcrypt hash, the pre_registered clear, and the
-- audit rows (patient.identity_verified, visit.created, visit_pin.issued,
-- package.decomposed) — so a crash can no longer leave a visit without its
-- lines, PIN or audit trail. Prices come from the app (pure reads + TS
-- arithmetic, src/lib/visits/encounter-payload.ts); this re-checks the actor,
-- the shape and that each visit's total equals its lines. P0073 = refused
-- here (message passes through); P0058 = inactive patient.
-- ---------------------------------------------------------------------------
create or replace function public.create_visit_encounter(
  p_actor          uuid,
  p_patient_id     uuid,
  p_pin_hash       text,
  p_visits         jsonb,
  p_visit_group_id uuid  default null,   -- set only for a split (doctor + lab) encounter
  p_context        jsonb default null    -- {ip, user_agent} for the audit rows
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_ip       inet;
  v_ua       text := left(nullif(p_context ->> 'user_agent', ''), 512);
  v_visit    jsonb;
  v_lines    jsonb;
  v_total    numeric;
  v_sum_c    bigint;    -- centavos
  v_id       uuid;
  v_number   text;
  v_hmo      uuid;
  v_out      jsonb := '[]'::jsonb;
  v_verified boolean;
begin
  if p_actor is null or not exists (
    select 1 from public.staff_profiles s
     where s.id = p_actor and s.role in ('reception', 'admin') and s.is_active and s.deleted_at is null
  ) then
    raise exception 'only active reception or admin staff can start a visit' using errcode = 'P0073';
  end if;
  if p_patient_id is null then
    raise exception 'choose a patient' using errcode = 'P0073';
  end if;
  if jsonb_typeof(p_visits) is distinct from 'array' or jsonb_array_length(p_visits) not in (1, 2) then
    raise exception 'a visit encounter has one or two visits' using errcode = 'P0073';
  end if;
  if (jsonb_array_length(p_visits) = 2) <> (p_visit_group_id is not null) then
    raise exception 'a split encounter needs a group id, and only a split one has one' using errcode = 'P0073';
  end if;
  if p_pin_hash is null or p_pin_hash !~ '^\$2[aby]\$[0-9]{2}\$.{53}$' then
    raise exception 'the portal PIN was not hashed' using errcode = 'P0073';
  end if;
  if p_context is not null and (
       jsonb_typeof(p_context) <> 'object'
       or exists (select 1 from jsonb_object_keys(p_context) k where k not in ('ip', 'user_agent'))) then
    raise exception 'unexpected audit context' using errcode = 'P0073';
  end if;
  begin
    v_ip := nullif(p_context ->> 'ip', '')::inet;
  exception when invalid_text_representation then
    v_ip := null;
  end;

  -- Shape of every line, before anything is written.
  for v_visit in select value from jsonb_array_elements(p_visits) loop
    v_lines := v_visit -> 'lines';
    if jsonb_typeof(v_lines) is distinct from 'array' or jsonb_array_length(v_lines) = 0 then
      raise exception 'each visit needs at least one line' using errcode = 'P0073';
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_lines) l
       where (l ->> 'id') is null or (l ->> 'service_id') is null
          or coalesce(l ->> 'status', '') not in ('requested', 'in_progress')
          or ((l ->> 'is_package_header')::boolean) is distinct from ((l ->> 'status') = 'in_progress')
          or (nullif(l ->> 'parent_id', '') is not null and not exists (
                select 1 from jsonb_array_elements(v_lines) h
                 where h ->> 'id' = l ->> 'parent_id' and (h ->> 'is_package_header')::boolean))
    ) then
      raise exception 'a bill line is malformed (missing id, bad status, or a component without its package)'
        using errcode = 'P0073';
    end if;
    -- Compared in integer CENTAVOS: the app sums JS numbers (100.10 + 200.20
    -- arrives as 300.29999999999995) and every money column is numeric(10,2).
    v_total := (v_visit -> 'visit' ->> 'total_php')::numeric;
    select coalesce(sum(round((l ->> 'final_price_php')::numeric * 100)), 0)::bigint into v_sum_c
      from jsonb_array_elements(v_lines) l;
    if v_total is null or round(v_total * 100)::bigint <> v_sum_c then
      raise exception 'the visit total (%) does not match its lines (%)', round(v_total, 2), v_sum_c / 100.0
        using errcode = 'P0073';
    end if;
  end loop;

  -- The patient's lifecycle lock (shared) before the first row is written.
  perform public.lifecycle_lock_and_assert(array[p_patient_id], false);

  -- M5: a visit means the patient is at the counter — identity verified.
  update public.patients set pre_registered = false where id = p_patient_id and pre_registered;
  v_verified := found;
  if v_verified then
    insert into public.audit_log (actor_id, actor_type, patient_id, action, resource_type, resource_id,
                                  metadata, ip_address, user_agent)
    values (p_actor, 'staff', p_patient_id, 'patient.identity_verified', 'patient', p_patient_id,
            jsonb_build_object('via', 'visit_created'), v_ip, v_ua);
  end if;

  for v_visit in select value from jsonb_array_elements(p_visits) with ordinality as t(value, n) order by n loop
    v_lines := v_visit -> 'lines';
    v_total := round((v_visit -> 'visit' ->> 'total_php')::numeric, 2);   -- centavos, as checked above
    v_hmo   := nullif(v_visit -> 'visit' ->> 'hmo_provider_id', '')::uuid;

    insert into public.visits (patient_id, total_php, notes, created_by, hmo_provider_id, hmo_approval_date,
                               hmo_authorization_no, attending_physician_id, visit_group_id, is_sample)
    values (p_patient_id, v_total, nullif(v_visit -> 'visit' ->> 'notes', ''), p_actor, v_hmo,
            nullif(v_visit -> 'visit' ->> 'hmo_approval_date', '')::date,
            nullif(v_visit -> 'visit' ->> 'hmo_authorization_no', ''),
            nullif(v_visit -> 'visit' ->> 'attending_physician_id', '')::uuid,
            p_visit_group_id,
            coalesce((v_visit -> 'visit' ->> 'is_sample')::boolean, false))
    returning id, visit_number into v_id, v_number;

    -- Headers + standalone lines, then components. The money columns are
    -- numeric(10,2): the assignment cast rounds every amount to centavos.
    insert into public.test_requests (id, visit_id, service_id, requested_by, base_price_php, discount_kind,
                                      discount_amount_php, final_price_php, hmo_provider_id, hmo_approval_date,
                                      hmo_authorization_no, receptionist_remarks, clinic_fee_php, doctor_pf_php,
                                      procedure_description, hmo_approved_amount_php, parent_id,
                                      is_package_header, status)
    select x.id, v_id, x.service_id, p_actor, x.base_price_php, x.discount_kind,
           coalesce(x.discount_amount_php, 0), x.final_price_php, x.hmo_provider_id, x.hmo_approval_date,
           x.hmo_authorization_no, x.receptionist_remarks, x.clinic_fee_php, x.doctor_pf_php,
           x.procedure_description, x.hmo_approved_amount_php, x.parent_id, x.is_package_header, x.status
      from jsonb_to_recordset(v_lines) as x(id uuid, service_id uuid, base_price_php numeric, discount_kind text,
             discount_amount_php numeric, final_price_php numeric, hmo_provider_id uuid, hmo_approval_date date,
             hmo_authorization_no text, receptionist_remarks text, clinic_fee_php numeric, doctor_pf_php numeric,
             procedure_description text, hmo_approved_amount_php numeric, parent_id uuid,
             is_package_header boolean, status text)
     where x.parent_id is null;
    insert into public.test_requests (id, visit_id, service_id, requested_by, base_price_php, discount_kind,
                                      discount_amount_php, final_price_php, hmo_provider_id, hmo_approval_date,
                                      hmo_authorization_no, receptionist_remarks, clinic_fee_php, doctor_pf_php,
                                      procedure_description, hmo_approved_amount_php, parent_id,
                                      is_package_header, status)
    select x.id, v_id, x.service_id, p_actor, x.base_price_php, x.discount_kind,
           coalesce(x.discount_amount_php, 0), x.final_price_php, x.hmo_provider_id, x.hmo_approval_date,
           x.hmo_authorization_no, x.receptionist_remarks, x.clinic_fee_php, x.doctor_pf_php,
           x.procedure_description, x.hmo_approved_amount_php, x.parent_id, x.is_package_header, x.status
      from jsonb_to_recordset(v_lines) as x(id uuid, service_id uuid, base_price_php numeric, discount_kind text,
             discount_amount_php numeric, final_price_php numeric, hmo_provider_id uuid, hmo_approval_date date,
             hmo_authorization_no text, receptionist_remarks text, clinic_fee_php numeric, doctor_pf_php numeric,
             procedure_description text, hmo_approved_amount_php numeric, parent_id uuid,
             is_package_header boolean, status text)
     where x.parent_id is not null;

    insert into public.visit_pins (visit_id, pin_hash) values (v_id, p_pin_hash);

    insert into public.audit_log (actor_id, actor_type, patient_id, action, resource_type, resource_id,
                                  metadata, ip_address, user_agent)
    select p_actor, 'staff', p_patient_id, 'visit.created', 'visit', v_id,
           jsonb_build_object(
             'visit_number', v_number,
             'total_php', v_total,
             'service_count', count(*) filter (where nullif(l ->> 'parent_id', '') is null),
             'visit_group_id', p_visit_group_id,
             'hmo_provider_id', v_hmo,
             'discounted_lines', count(*) filter (where nullif(l ->> 'parent_id', '') is null
                                                   and coalesce((l ->> 'discount_amount_php')::numeric, 0) > 0),
             'is_sample', coalesce((v_visit -> 'visit' ->> 'is_sample')::boolean, false)),
           v_ip, v_ua
      from jsonb_array_elements(v_lines) l;

    -- Never the PIN or its hash (RA 10173) — only that one was issued.
    insert into public.audit_log (actor_id, actor_type, patient_id, action, resource_type, resource_id,
                                  metadata, ip_address, user_agent)
    values (p_actor, 'staff', p_patient_id, 'visit_pin.issued', 'visit', v_id,
            jsonb_build_object('visit_number', v_number, 'reason', 'visit_created'), v_ip, v_ua);

    insert into public.audit_log (actor_id, actor_type, patient_id, action, resource_type, resource_id,
                                  metadata, ip_address, user_agent)
    select p_actor, 'staff', p_patient_id, 'package.decomposed', 'test_request', (h.value ->> 'id')::uuid,
           jsonb_build_object(
             'visit_id', v_id,
             'package_service_id', (h.value ->> 'service_id')::uuid,
             'package_code', s.code,
             'package_name', s.name,
             'component_count', (select count(*) from jsonb_array_elements(v_lines) c
                                  where c ->> 'parent_id' = h.value ->> 'id'),
             'component_service_ids', coalesce((select jsonb_agg(c.value ->> 'service_id' order by c.n)
                                                  from jsonb_array_elements(v_lines) with ordinality as c(value, n)
                                                 where c.value ->> 'parent_id' = h.value ->> 'id'), '[]'::jsonb)),
           v_ip, v_ua
      from jsonb_array_elements(v_lines) as h(value)
      left join public.services s on s.id = (h.value ->> 'service_id')::uuid
     where (h.value ->> 'is_package_header')::boolean;

    v_out := v_out || jsonb_build_array(jsonb_build_object('id', v_id, 'visit_number', v_number));
  end loop;

  return jsonb_build_object('visits', v_out, 'identity_verified', v_verified);
end;
$$;

revoke all on function public.create_visit_encounter(uuid, uuid, text, jsonb, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.create_visit_encounter(uuid, uuid, text, jsonb, uuid, jsonb) to service_role;
