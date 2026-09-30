-- =============================================================================
-- 0196_patient_merge_atomic.sql — patient-delete rollout PR 3b
-- =============================================================================
-- Merge and undo-merge become two atomic, service_role-only functions owned by
-- the private role patient_merge_writer, replacing the app-side multi-statement
-- merge (admin page + dedup CLI) and its hand-built rollback runner.
-- Spec: docs/superpowers/specs/2026-09-30-patient-merge-atomic-design.md
--
--   (1) private role patient_merge_writer (0167 pattern)
--   (2) patient_merges: snapshot_version, fill_snapshot, rechained, context,
--       undo_report; one live merge per source
--   (3) table privileges + role-scoped RLS policies
--   (4) consent cache: recompute_patient_consent_cache() folds the events in
--       seq order; sync_patient_consent_state() delegates to it
--   (5) rollback guard: a live version-2 merge's marker only changes through
--       the writer (so an app rolled back to pre-3b cannot run its old undo)
--   (6) merge_patients_guarded
--   (7) undo_patient_merge_guarded
--   (8) ownership + ACLs
--   (9) post-conditions (incl. consent fold = cache for every patient)
--
-- Error codes: P0058 (inactive/missing record, message passes through),
-- P0072 (records changed while waiting — retried once by every caller),
-- P0078 (actor not an active admin), P0079 (merge/undo refused — message
-- passes through), P0080 (merge marker changed outside the merge functions).
-- Merge-marker enforcement for EVERY writer ships separately in 0197, after
-- the app that calls these functions is deployed.
-- =============================================================================

set lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- (1) Private role. Restated every run (idempotent).
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'patient_merge_writer') then
    create role patient_merge_writer nologin noinherit nobypassrls;
  end if;
end
$$;
alter role patient_merge_writer nologin noinherit nobypassrls;
-- INHERIT lets postgres re-run create-or-replace on the functions this role
-- owns; SET lets local fixtures act as it. No runtime role may assume it.
grant patient_merge_writer to postgres with inherit true, set true;
revoke patient_merge_writer from anon, authenticated, service_role, authenticator;
grant usage on schema public to patient_merge_writer;

-- ---------------------------------------------------------------------------
-- (2) Ledger. Legacy rows (written by the pre-3b app) keep snapshot_version
-- NULL; every row the new function writes is version 2.
-- ---------------------------------------------------------------------------
alter table public.patient_merges
  add column if not exists snapshot_version smallint,
  add column if not exists fill_snapshot jsonb,
  add column if not exists rechained uuid[] not null default '{}',
  add column if not exists context jsonb,
  add column if not exists undo_report jsonb;
alter table public.patient_merges drop constraint if exists patient_merges_snapshot_version_check;
alter table public.patient_merges add constraint patient_merges_snapshot_version_check
  check (snapshot_version is null or snapshot_version = 2);
create unique index if not exists uq_patient_merges_live_source
  on public.patient_merges (source_id) where undone_at is null;

-- ---------------------------------------------------------------------------
-- (3) Privileges. NOBYPASSRLS: every table needs a grant AND a policy.
-- patient_merges and patient_consents were RLS-on/no-policy tables (0151's
-- list, 0202's service_role-only ACL). The policies below name ONLY this
-- NOLOGIN role, which nothing but the two merge functions runs as; anon and
-- authenticated still hold no privilege on either table (0202's invariant,
-- re-checked by the 0196 smoke s1.11).
-- ---------------------------------------------------------------------------
grant select on public.patients, public.visits, public.appointments, public.audit_log,
                public.critical_alerts, public.patient_consents, public.appointment_attachments,
                public.test_requests, public.result_test_requests, public.staff_profiles,
                public.patient_merges
  to patient_merge_writer;
grant update (middle_name, sex, phone, email, address, birthdate, is_repeat_patient,
              merged_into_id, merged_at)
  on public.patients to patient_merge_writer;
grant update (patient_id) on public.visits, public.appointments, public.audit_log,
                             public.patient_consents, public.appointment_attachments
  to patient_merge_writer;
grant update (patient_id, patient_drm_id) on public.critical_alerts to patient_merge_writer;
grant insert on public.audit_log to patient_merge_writer;
grant usage on sequence public.audit_log_id_seq to patient_merge_writer;
grant insert, update on public.patient_merges to patient_merge_writer;

do $$
declare
  t text;
begin
  foreach t in array array['patients', 'visits', 'appointments', 'audit_log', 'critical_alerts',
                           'patient_consents', 'appointment_attachments', 'test_requests',
                           'result_test_requests', 'staff_profiles', 'patient_merges'] loop
    execute format('drop policy if exists %I on public.%I', t || ': merge writer select', t);
    execute format('create policy %I on public.%I for select to patient_merge_writer using (true)',
                   t || ': merge writer select', t);
  end loop;
  foreach t in array array['patients', 'visits', 'appointments', 'audit_log', 'critical_alerts',
                           'patient_consents', 'appointment_attachments', 'patient_merges'] loop
    execute format('drop policy if exists %I on public.%I', t || ': merge writer update', t);
    execute format('create policy %I on public.%I for update to patient_merge_writer using (true) with check (true)',
                   t || ': merge writer update', t);
  end loop;
end
$$;

drop policy if exists "audit_log: merge writer insert" on public.audit_log;
create policy "audit_log: merge writer insert" on public.audit_log
  for insert to patient_merge_writer
  with check (action in ('patient.merged', 'patient.merge.undone'));
drop policy if exists "patient_merges: merge writer insert" on public.patient_merges;
create policy "patient_merges: merge writer insert" on public.patient_merges
  for insert to patient_merge_writer with check (true);

-- ---------------------------------------------------------------------------
-- (4) Consent cache. 0086's trigger fires AFTER INSERT only, so moving events
-- by UPDATE (merge / undo) never re-synced either patient. The fold below is
-- 0162's three transitions applied to every event in seq order — equal to what
-- the incremental trigger produced, since seq is insertion order (proved for
-- every patient in section 9). Owned by postgres; the writer gets EXECUTE.
-- ---------------------------------------------------------------------------
create or replace function public.recompute_patient_consent_cache(p_patient_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  e        record;
  v_cur    boolean := false;
  v_signed timestamptz;
  v_wd     timestamptz;
  v_method text;
  v_nv     text;
begin
  for e in
    select c.event_type, c.consent_scope, c.created_at, c.method, c.notice_version
      from public.patient_consents c
     where c.patient_id = p_patient_id
     order by c.seq
  loop
    if e.event_type = 'granted' and e.consent_scope = 'full' then
      v_cur := true; v_signed := e.created_at; v_wd := null; v_method := e.method; v_nv := e.notice_version;
    elsif e.event_type = 'granted' then
      -- booking-only grant: as if never consented (0162)
      v_cur := false; v_signed := null; v_wd := null; v_method := null; v_nv := null;
    else
      -- withdrawal: signed/method/version stay as the historical grant (0162)
      v_cur := false; v_wd := e.created_at;
    end if;
  end loop;

  update public.patients p
     set consent_current = v_cur,
         consent_signed_at = v_signed,
         consent_withdrawn_at = v_wd,
         consent_method = v_method,
         consent_notice_version = v_nv
   where p.id = p_patient_id
     and (p.consent_current, p.consent_signed_at, p.consent_withdrawn_at, p.consent_method, p.consent_notice_version)
         is distinct from (v_cur, v_signed, v_wd, v_method, v_nv);
end;
$$;

revoke all on function public.recompute_patient_consent_cache(uuid) from public, anon, authenticated, service_role;
grant execute on function public.recompute_patient_consent_cache(uuid) to patient_merge_writer;

create or replace function public.sync_patient_consent_state()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public.recompute_patient_consent_cache(new.patient_id);
  return null;
end;
$$;

revoke execute on function public.sync_patient_consent_state() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- (5) Rollback guard (spec R7). A live version-2 merge records chain
-- re-parenting and fill snapshots the pre-3b app's Undo would ignore. If the
-- app is ever rolled back, that Undo's FIRST statement is clearing the
-- source's marker — refused here, so it stops with nothing changed. Old-app
-- merges and undos of legacy rows are untouched. 0197 later enforces the
-- marker for every writer.
-- ---------------------------------------------------------------------------
create or replace function public.patient_has_live_v2_merge(p_patient_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (
    select 1 from public.patient_merges m
     where m.source_id = p_patient_id and m.undone_at is null and m.snapshot_version = 2
  );
$$;

revoke all on function public.patient_has_live_v2_merge(uuid) from public, anon, authenticated, service_role;
-- patient_merge_writer also needs EXECUTE here even though the guard trigger
-- only *acts* on this function's result when current_user <> 'patient_merge_writer':
-- Postgres does not guarantee left-to-right / short-circuit evaluation of AND
-- (docs 4.2.14), so this arm CAN be evaluated even when the writer role is the
-- one updating merged_into_id. Without the grant that evaluation itself raises
-- permission-denied and blocks the writer's own legitimate writes; granting it
-- does not weaken the guard, since the AND still requires the other arms true.
grant execute on function public.patient_has_live_v2_merge(uuid) to authenticated, service_role, patient_merge_writer;

-- SECURITY INVOKER: current_user is the role actually writing.
create or replace function public.guard_live_merge_marker()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.merged_into_id is distinct from old.merged_into_id
     and current_user <> 'patient_merge_writer'
     and public.patient_has_live_v2_merge(old.id) then
    raise exception '% was merged in Admin Tools — undo it there', old.drm_id
      using errcode = 'P0080';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_live_merge_marker() from public, anon, authenticated, service_role;

drop trigger if exists trg_patients_live_merge_guard on public.patients;
create trigger trg_patients_live_merge_guard
  before update of merged_into_id on public.patients
  for each row execute function public.guard_live_merge_marker();

-- ---------------------------------------------------------------------------
-- (6) merge_patients_guarded — one transaction. Refusals: P0078 (actor),
-- P0079 (pair / context), P0058 (inactive or missing record), P0072 (the
-- chain or the affected results changed while waiting — the caller retries
-- once). Anything else aborts the whole merge; there is no partial merge.
-- ---------------------------------------------------------------------------
create or replace function public.merge_patients_guarded(
  p_keep uuid, p_source uuid, p_actor uuid, p_context jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  k_fill constant text[] := array['middle_name', 'sex', 'phone', 'email', 'address', 'birthdate'];
  v_ip        inet;
  v_ctx       jsonb;
  v_chain     uuid[];
  v_chain2    uuid[];
  v_results   uuid[];
  v_results2  uuid[];
  v_keep      public.patients%rowtype;
  v_source    public.patients%rowtype;
  v_visits    uuid[];
  v_appts     uuid[];
  v_audit     bigint[];
  v_alerts    uuid[];
  v_consents  uuid[];
  v_attach    uuid[];
  v_counts    jsonb;
  v_kj        jsonb;
  v_sj        jsonb;
  v_after     jsonb;
  v_filled    text[] := '{}';
  v_fill      jsonb := '{}'::jsonb;
  v_rechained uuid[];
  v_merge_id  uuid;
  f           text;
begin
  -- (1) Validate.
  if p_actor is null or not exists (
    select 1 from public.staff_profiles s
     where s.id = p_actor and s.role = 'admin' and s.is_active and s.deleted_at is null
  ) then
    raise exception 'only an active admin can merge patient records' using errcode = 'P0078';
  end if;
  if p_keep is null or p_source is null or p_keep = p_source then
    raise exception 'pick two different patient records to merge' using errcode = 'P0079';
  end if;
  if p_context is not null and (
       jsonb_typeof(p_context) <> 'object'
       or exists (select 1 from jsonb_object_keys(p_context) k where k not in ('ip', 'user_agent', 'source', 'tier'))
       or coalesce(p_context->>'source', 'admin') not in ('admin', 'candidates', 'dedup-cli')
       or length(coalesce(p_context->>'tier', '')) > 40
     ) then
    raise exception 'unexpected merge context' using errcode = 'P0079';
  end if;
  begin
    v_ip := nullif(p_context->>'ip', '')::inet;
  exception when invalid_text_representation then
    v_ip := null;
  end;
  v_ctx := jsonb_strip_nulls(jsonb_build_object(
    'source', coalesce(p_context->>'source', 'admin'),
    'tier', nullif(p_context->>'tier', '')));

  -- (2) Lock: result membership → patients → rows, then re-resolve.
  select coalesce(array_agg(p.id order by p.id), '{}') into v_chain
    from public.patients p where p.merged_into_id = p_source;
  select coalesce(array_agg(distinct x.r order by x.r), '{}') into v_results
    from (
      select rtr.result_id as r
        from public.result_test_requests rtr
        join public.test_requests t on t.id = rtr.test_request_id
        join public.visits v on v.id = t.visit_id
       where v.patient_id = p_source
      union
      select ca.result_id from public.critical_alerts ca where ca.patient_id = p_source
    ) x;

  perform public.lifecycle_lock_results(v_results, false);
  perform public.lifecycle_lock(array[p_keep, p_source] || v_chain, true);
  perform 1 from public.patients p
    where p.id = any(array[p_keep, p_source] || v_chain)
    order by p.id
    for no key update;

  select coalesce(array_agg(p.id order by p.id), '{}') into v_chain2
    from public.patients p where p.merged_into_id = p_source;
  select coalesce(array_agg(distinct x.r order by x.r), '{}') into v_results2
    from (
      select rtr.result_id as r
        from public.result_test_requests rtr
        join public.test_requests t on t.id = rtr.test_request_id
        join public.visits v on v.id = t.visit_id
       where v.patient_id = p_source
      union
      select ca.result_id from public.critical_alerts ca where ca.patient_id = p_source
    ) x;
  if v_chain2 is distinct from v_chain or not (v_results2 <@ v_results) then
    raise exception 'the patient records changed while the merge was waiting — try again'
      using errcode = 'P0072';
  end if;

  -- (3) Both records exist and are active.
  select * into v_keep from public.patients where id = p_keep;
  if not found then
    raise exception 'the patient record to keep was not found' using errcode = 'P0058';
  end if;
  select * into v_source from public.patients where id = p_source;
  if not found then
    raise exception 'the patient record to merge in was not found' using errcode = 'P0058';
  end if;
  if v_keep.deleted_at is not null or v_source.deleted_at is not null then
    raise exception '% is deleted — restore it from Admin Tools › Deleted Patients before merging',
      case when v_keep.deleted_at is not null then v_keep.drm_id else v_source.drm_id end
      using errcode = 'P0058';
  end if;
  if v_keep.merged_into_id is not null or v_source.merged_into_id is not null then
    raise exception '% has already been merged into another record — refresh and try again',
      case when v_keep.merged_into_id is not null then v_keep.drm_id else v_source.drm_id end
      using errcode = 'P0058';
  end if;

  -- (4) Move, in this order (visits before critical_alerts: 0184's
  -- alert-matches-its-test check). Each UPDATE fires a_lifecycle_guard, whose
  -- exclusive locks on old ∪ new are already held.
  with m as (update public.visits set patient_id = p_keep where patient_id = p_source returning id)
  select coalesce(array_agg(id order by id), '{}') into v_visits from m;
  with m as (update public.appointments set patient_id = p_keep where patient_id = p_source returning id)
  select coalesce(array_agg(id order by id), '{}') into v_appts from m;
  with m as (update public.audit_log set patient_id = p_keep where patient_id = p_source returning id)
  select coalesce(array_agg(id order by id), '{}') into v_audit from m;
  -- patient_drm_id is the copy three staff surfaces print; an open alert must
  -- not send staff to a retired DRM-ID.
  with m as (update public.critical_alerts set patient_id = p_keep, patient_drm_id = v_keep.drm_id
              where patient_id = p_source returning id)
  select coalesce(array_agg(id order by id), '{}') into v_alerts from m;
  with m as (update public.patient_consents set patient_id = p_keep where patient_id = p_source returning id)
  select coalesce(array_agg(id order by id), '{}') into v_consents from m;
  with m as (update public.appointment_attachments set patient_id = p_keep where patient_id = p_source returning id)
  select coalesce(array_agg(id order by id), '{}') into v_attach from m;

  v_counts := jsonb_build_object(
    'visits', cardinality(v_visits), 'appointments', cardinality(v_appts),
    'audit_log', cardinality(v_audit), 'critical_alerts', cardinality(v_alerts),
    'patient_consents', cardinality(v_consents), 'appointment_attachments', cardinality(v_attach));

  -- (5) Consent cache for both — the source BEFORE it becomes a tombstone.
  perform public.recompute_patient_consent_cache(p_source);
  perform public.recompute_patient_consent_cache(p_keep);

  -- The repeat flag is set on visit INSERT only; the kept record may now
  -- have several visits. Set-only, like the trigger.
  update public.patients set is_repeat_patient = true
   where id = p_keep and not is_repeat_patient
     and (select count(*) from public.visits v where v.patient_id = p_keep) > 1;

  -- (6) Fill NULL/blank fields on keep from source; never overwrite.
  select to_jsonb(p) into v_kj from public.patients p where p.id = p_keep;
  v_sj := to_jsonb(v_source);
  foreach f in array k_fill loop
    if nullif(btrim(coalesce(v_kj->>f, '')), '') is null
       and nullif(btrim(coalesce(v_sj->>f, '')), '') is not null then
      v_filled := v_filled || f;
    end if;
  end loop;
  if cardinality(v_filled) > 0 then
    update public.patients p set
      middle_name = case when 'middle_name' = any(v_filled) then v_source.middle_name else p.middle_name end,
      sex         = case when 'sex' = any(v_filled) then v_source.sex else p.sex end,
      phone       = case when 'phone' = any(v_filled) then v_source.phone else p.phone end,
      email       = case when 'email' = any(v_filled) then v_source.email else p.email end,
      address     = case when 'address' = any(v_filled) then v_source.address else p.address end,
      birthdate   = case when 'birthdate' = any(v_filled) then v_source.birthdate else p.birthdate end
     where p.id = p_keep;
    -- "after" is what the row holds once its normalising triggers ran.
    select to_jsonb(p) into v_after from public.patients p where p.id = p_keep;
    foreach f in array v_filled loop
      v_fill := v_fill || jsonb_build_object(f, jsonb_build_object('before', v_kj->f, 'after', v_after->f));
    end loop;
  end if;

  -- (7) Flatten the chain: older tombstones of the source now point at keep.
  with c as (update public.patients set merged_into_id = p_keep where merged_into_id = p_source returning id)
  select coalesce(array_agg(id order by id), '{}') into v_rechained from c;

  -- (8) Tombstone the source.
  update public.patients set merged_into_id = p_keep, merged_at = now() where id = p_source;

  -- (9) Ledger (version 2).
  insert into public.patient_merges (keep_id, source_id, merged_by, moved, filled_from_source,
                                     snapshot_version, fill_snapshot, rechained, context)
  values (p_keep, p_source, p_actor,
          jsonb_build_object(
            'visits', to_jsonb(v_visits), 'appointments', to_jsonb(v_appts),
            'audit_log', to_jsonb(v_audit), 'critical_alerts', to_jsonb(v_alerts),
            'patient_consents', to_jsonb(v_consents), 'appointment_attachments', to_jsonb(v_attach)),
          v_filled, 2, v_fill, v_rechained, v_ctx)
  returning id into v_merge_id;

  -- (10) Audit, same transaction.
  insert into public.audit_log (actor_id, actor_type, patient_id, action, resource_type, resource_id,
                                metadata, ip_address, user_agent)
  values (p_actor, 'staff', p_keep, 'patient.merged', 'patient', p_keep,
          jsonb_build_object(
            'merge_id', v_merge_id, 'kept_drm_id', v_keep.drm_id, 'merged_drm_id', v_source.drm_id,
            'merged_patient_id', p_source, 'moved', v_counts, 'filled_from_source', to_jsonb(v_filled),
            'rechained', cardinality(v_rechained)) || v_ctx,
          v_ip, left(nullif(p_context->>'user_agent', ''), 512));

  return jsonb_build_object(
    'merge_id', v_merge_id, 'keep_id', p_keep, 'source_id', p_source,
    'kept_drm_id', v_keep.drm_id, 'merged_drm_id', v_source.drm_id,
    'moved', v_counts, 'filled', to_jsonb(v_filled), 'rechained', cardinality(v_rechained));
end;
$$;
