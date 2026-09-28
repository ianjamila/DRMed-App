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
-- before another trigger takes a row lock (0183's planned payments guard locks
-- visits FOR UPDATE). SECURITY DEFINER (see (1)); EXECUTE revoked — firing
-- needs none.
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
  -- an alert at another result/test/patient) would change what dependent
  -- writers must lock without taking any lock they conflict with. Nothing in
  -- the app or SQL rebinds these; a correction is a new row.
  if tg_op = 'UPDATE' then
    if tg_table_name = 'result_amendments' and v_changed && array['result_id', 'test_request_id'] then
      raise exception 'a correction record stays on its result and test — record a new correction instead'
        using errcode = '23514';
    end if;
    if tg_table_name = 'critical_alerts' and v_changed && array['result_id', 'test_request_id', 'patient_id'] then
      raise exception 'a critical alert stays on its result, test and patient'
        using errcode = '23514';
    end if;
  end if;

  -- (a3) ON DELETE SET NULL on critical_alerts.withdrawn_by_amendment (0179):
  -- deleting an amendment (directly, or cascading from its result or test)
  -- UPDATEs the alert after the amendment row is gone. That OLD reference
  -- can no longer be resolved; drop just that key so it does not fail closed
  -- as "patient not found" — the alert's result, test and patient_id are
  -- still locked and asserted below. Only this exact shape qualifies: the new
  -- value is NULL and the referenced amendment no longer exists.
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
