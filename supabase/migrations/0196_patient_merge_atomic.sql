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
grant execute on function public.patient_has_live_v2_merge(uuid) to authenticated, service_role;
-- patient_merge_writer does NOT get EXECUTE here (idempotent: the local DB may
-- still hold an earlier grant, so revoke it explicitly). guard_live_merge_marker
-- below nests the call inside a SEPARATE inner IF, rather than ANDing it onto
-- the outer condition: Postgres checks EXECUTE privilege on a function call
-- when it INITIALISES that expression's plan, not lazily as AND short-circuits
-- at evaluation time (docs 4.2.14) — a single ANDed condition would need the
-- grant even for the arm that never actually needs to run. A nested IF is its
-- own statement, only planned once control reaches it, so when the writer is
-- the one updating merged_into_id (current_user = 'patient_merge_writer') the
-- outer IF is false and the inner call is never planned or checked at all.
revoke execute on function public.patient_has_live_v2_merge(uuid) from patient_merge_writer;

-- SECURITY INVOKER: current_user is the role actually writing.
create or replace function public.guard_live_merge_marker()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.merged_into_id is distinct from old.merged_into_id
     and current_user <> 'patient_merge_writer' then
    if public.patient_has_live_v2_merge(old.id) then
      raise exception '% was merged in Admin Tools — undo it there', old.drm_id
        using errcode = 'P0080';
    end if;
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
  v_repeat_n  int;
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
  -- An active record that is itself the SOURCE of a live ledger row (undone_at
  -- is null) can only be an interrupted legacy undo (0196's resume path is the
  -- only way an active record keeps a live source row) — merging it again
  -- would fork that half-finished history, and would otherwise hit the raw
  -- uq_patient_merges_live_source unique violation (23505) the moment this
  -- record becomes a source again.
  if exists (select 1 from public.patient_merges pm where pm.source_id = p_keep and pm.undone_at is null) then
    raise exception '% has an unfinished undo of an earlier merge — finish it from Admin Tools › Possible duplicates › Recently merged first',
      v_keep.drm_id using errcode = 'P0079';
  end if;
  if exists (select 1 from public.patient_merges pm where pm.source_id = p_source and pm.undone_at is null) then
    raise exception '% has an unfinished undo of an earlier merge — finish it from Admin Tools › Possible duplicates › Recently merged first',
      v_source.drm_id using errcode = 'P0079';
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
  -- have several visits. Set-only, like the trigger. Recorded in context (so
  -- it lands in the ledger AND the audit row) only when this UPDATE actually
  -- flips it — undo uses that to know whether to revert it (F5).
  update public.patients set is_repeat_patient = true
   where id = p_keep and not is_repeat_patient
     and (select count(*) from public.visits v where v.patient_id = p_keep) > 1;
  get diagnostics v_repeat_n = row_count;
  if v_repeat_n > 0 then
    v_ctx := v_ctx || jsonb_build_object('repeat_flag_set', true);
  end if;

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

-- ---------------------------------------------------------------------------
-- (7) undo_patient_merge_guarded — one transaction. Refusals: P0078 (actor),
-- P0079 (not undoable — message passes through), P0072 (the affected results
-- changed while waiting — retried once by the caller).
-- ---------------------------------------------------------------------------
create or replace function public.undo_patient_merge_guarded(
  p_merge_id uuid, p_actor uuid, p_context jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  k_fill constant text[] := array['middle_name', 'sex', 'phone', 'email', 'address', 'birthdate'];
  v_ip          inet;
  m             public.patient_merges%rowtype;
  v_legacy      boolean;
  v_resume      boolean := false;
  v_keep        public.patients%rowtype;
  v_source      public.patients%rowtype;
  v_mv_visits   uuid[];
  v_mv_appts    uuid[];
  v_mv_audit    bigint[];
  v_mv_alerts   uuid[];
  v_mv_consents uuid[];
  v_mv_attach   uuid[];
  v_results     uuid[];
  v_results2    uuid[];
  v_split       uuid;
  v_b_visits    uuid[];
  v_b_appts     uuid[];
  v_b_audit     bigint[];
  v_b_alerts    uuid[];
  v_b_consents  uuid[];
  v_b_attach    uuid[];
  v_kj          jsonb;
  v_sj          jsonb;
  v_revert      text[] := '{}';
  v_kept        text[] := '{}';
  v_before      jsonb := '{}'::jsonb;
  v_rechained   uuid[];
  v_repeat_n        int;
  v_repeat_reverted boolean := false;
  v_left        jsonb;
  v_report      jsonb;
  f             text;
begin
  -- (1) Validate.
  if p_actor is null or not exists (
    select 1 from public.staff_profiles s
     where s.id = p_actor and s.role = 'admin' and s.is_active and s.deleted_at is null
  ) then
    raise exception 'only an active admin can undo a merge' using errcode = 'P0078';
  end if;
  if p_context is not null and (
       jsonb_typeof(p_context) <> 'object'
       or exists (select 1 from jsonb_object_keys(p_context) k where k not in ('ip', 'user_agent'))
     ) then
    raise exception 'unexpected undo context' using errcode = 'P0079';
  end if;
  begin
    v_ip := nullif(p_context->>'ip', '')::inet;
  exception when invalid_text_representation then
    v_ip := null;
  end;

  -- (2) The ledger row (plain read; re-read under lock below).
  select * into m from public.patient_merges where id = p_merge_id;
  if not found then
    raise exception 'merge record not found' using errcode = 'P0079';
  end if;
  v_legacy := m.snapshot_version is null;
  -- Defensive (F7/M6): a hand-edited or otherwise malformed ledger row's
  -- `moved` may hold null / a non-array scalar / a missing key for one of the
  -- six — jsonb_array_elements_text on anything but a JSON array raises a raw
  -- 22023, so treat anything that is not actually an array as empty.
  v_mv_visits   := array(select x::uuid   from jsonb_array_elements_text(
    case jsonb_typeof(m.moved->'visits') when 'array' then m.moved->'visits' else '[]'::jsonb end) x);
  v_mv_appts    := array(select x::uuid   from jsonb_array_elements_text(
    case jsonb_typeof(m.moved->'appointments') when 'array' then m.moved->'appointments' else '[]'::jsonb end) x);
  v_mv_audit    := array(select x::bigint from jsonb_array_elements_text(
    case jsonb_typeof(m.moved->'audit_log') when 'array' then m.moved->'audit_log' else '[]'::jsonb end) x);
  v_mv_alerts   := array(select x::uuid   from jsonb_array_elements_text(
    case jsonb_typeof(m.moved->'critical_alerts') when 'array' then m.moved->'critical_alerts' else '[]'::jsonb end) x);
  v_mv_consents := array(select x::uuid   from jsonb_array_elements_text(
    case jsonb_typeof(m.moved->'patient_consents') when 'array' then m.moved->'patient_consents' else '[]'::jsonb end) x);
  v_mv_attach   := array(select x::uuid   from jsonb_array_elements_text(
    case jsonb_typeof(m.moved->'appointment_attachments') when 'array' then m.moved->'appointment_attachments' else '[]'::jsonb end) x);

  -- (3) Lock: result membership over the COMPLETE undo scope (every recorded
  -- visit, whoever owns it now, and every alert on keep or source for their
  -- tests) → patients → ledger row → patient rows; then re-resolve.
  select coalesce(array_agg(distinct x.r order by x.r), '{}') into v_results
    from (
      select rtr.result_id as r
        from public.result_test_requests rtr
        join public.test_requests t on t.id = rtr.test_request_id
       where t.visit_id = any(v_mv_visits)
      union
      select ca.result_id
        from public.critical_alerts ca
        join public.test_requests t on t.id = ca.test_request_id
       where t.visit_id = any(v_mv_visits) and ca.patient_id in (m.keep_id, m.source_id)
    ) x;

  perform public.lifecycle_lock_results(v_results, false);
  perform public.lifecycle_lock(array[m.keep_id, m.source_id] || m.rechained, true);
  select * into m from public.patient_merges where id = p_merge_id for update;
  perform 1 from public.patients p
    where p.id = any(array[m.keep_id, m.source_id] || m.rechained)
    order by p.id
    for no key update;

  select coalesce(array_agg(distinct x.r order by x.r), '{}') into v_results2
    from (
      select rtr.result_id as r
        from public.result_test_requests rtr
        join public.test_requests t on t.id = rtr.test_request_id
       where t.visit_id = any(v_mv_visits)
      union
      select ca.result_id
        from public.critical_alerts ca
        join public.test_requests t on t.id = ca.test_request_id
       where t.visit_id = any(v_mv_visits) and ca.patient_id in (m.keep_id, m.source_id)
    ) x;
  if not (v_results2 <@ v_results) then
    raise exception 'the patient records changed while the undo was waiting — try again'
      using errcode = 'P0072';
  end if;

  -- (4) Refusals.
  if m.undone_at is not null then
    raise exception 'this merge was already undone' using errcode = 'P0079';
  end if;
  -- v_resume must be known BEFORE the 30-day check (F1): an interrupted old-app
  -- undo has already cleared the source's marker, so the source is active
  -- again with half its rows already back — that must always be completable,
  -- at any age. This mirrors merged_into_id = null AND legacy below without
  -- disturbing that if/elsif/else's own position (and its error precedence)
  -- later in this block.
  select * into v_keep from public.patients where id = m.keep_id;
  select * into v_source from public.patients where id = m.source_id;
  v_resume := (v_source.merged_into_id is null and v_legacy);
  if not v_resume and now() - m.merged_at >= interval '30 days' then
    raise exception 'merges can only be undone within 30 days' using errcode = 'P0079';
  end if;
  if v_keep.merged_into_id is not null then
    raise exception 'the kept record % has since been merged into another record — undo that merge first', v_keep.drm_id
      using errcode = 'P0079';
  end if;
  if v_keep.deleted_at is not null then
    raise exception 'the kept record % has since been deleted — restore it first', v_keep.drm_id
      using errcode = 'P0079';
  end if;
  if v_source.deleted_at is not null then
    raise exception 'the merged-in record % has since been deleted — restore it first', v_source.drm_id
      using errcode = 'P0079';
  end if;
  if v_source.merged_into_id = m.keep_id then
    null;
  elsif v_source.merged_into_id is null and v_legacy then
    v_resume := true;   -- redundant with the pre-30-day-check assignment above (F1);
                         -- restated so this branch reads standalone, same value either way
  else
    raise exception '% is no longer merged into %, so this merge cannot be undone', v_source.drm_id, v_keep.drm_id
      using errcode = 'P0079';
  end if;

  -- Split-result refusal: after the undo, every affected result must still
  -- link tests of exactly one patient.
  select x.result_id into v_split
    from (
      select rtr.result_id,
             count(distinct case when v.patient_id = m.keep_id and v.id = any(v_mv_visits)
                                 then m.source_id else v.patient_id end) as owners
        from public.result_test_requests rtr
        join public.test_requests t on t.id = rtr.test_request_id
        join public.visits v on v.id = t.visit_id
       where rtr.result_id = any(v_results2)
       group by rtr.result_id
    ) x
   where x.owners > 1
   limit 1;
  if v_split is not null then
    raise exception 'a lab result made after the merge combines tests from both records — correct that result before undoing'
      using errcode = 'P0079', detail = v_split::text;
  end if;

  -- (5) Clear the source's marker FIRST: the source is active again, so
  -- 0184's guards accept every move below without a bypass.
  if not v_resume then
    update public.patients set merged_into_id = null, merged_at = null where id = m.source_id;
  end if;

  -- (6) Move back. Recorded rows only while still on keep.
  with b as (update public.visits set patient_id = m.source_id
              where id = any(v_mv_visits) and patient_id = m.keep_id returning id)
  select coalesce(array_agg(id order by id), '{}') into v_b_visits from b;
  with b as (update public.appointments set patient_id = m.source_id
              where id = any(v_mv_appts) and patient_id = m.keep_id returning id)
  select coalesce(array_agg(id order by id), '{}') into v_b_appts from b;
  with b as (update public.audit_log set patient_id = m.source_id
              where id = any(v_mv_audit) and patient_id = m.keep_id returning id)
  select coalesce(array_agg(id order by id), '{}') into v_b_audit from b;
  -- Alerts follow their test's visit, recorded or not (created, acknowledged
  -- or withdrawn after the merge), re-stamped with the source's DRM-ID.
  with b as (update public.critical_alerts ca
                set patient_id = m.source_id, patient_drm_id = v_source.drm_id
               from public.test_requests t
               join public.visits v on v.id = t.visit_id
              where ca.test_request_id = t.id and ca.patient_id = m.keep_id and v.patient_id = m.source_id
             returning ca.id)
  select coalesce(array_agg(id order by id), '{}') into v_b_alerts from b;
  with b as (update public.patient_consents set patient_id = m.source_id
              where id = any(v_mv_consents) and patient_id = m.keep_id returning id)
  select coalesce(array_agg(id order by id), '{}') into v_b_consents from b;
  -- Attachments: evidence = the booking group's appointments that name a
  -- patient. Unrecorded uploads move only on positive evidence; recorded ones
  -- also move when the group has no evidence at all (empty / walk-in only).
  with b as (
    update public.appointment_attachments aa set patient_id = m.source_id
     where aa.patient_id = m.keep_id
       and (
         (exists (select 1 from public.appointments ap
                   where ap.booking_group_id = aa.booking_group_id and ap.patient_id is not null)
          and not exists (select 1 from public.appointments ap
                           where ap.booking_group_id = aa.booking_group_id and ap.patient_id is not null
                             and ap.patient_id <> m.source_id))
         or (aa.id = any(v_mv_attach)
             and not exists (select 1 from public.appointments ap
                              where ap.booking_group_id = aa.booking_group_id and ap.patient_id is not null))
       )
    returning aa.id)
  select coalesce(array_agg(id order by id), '{}') into v_b_attach from b;

  -- (7) Revert the fill.
  select to_jsonb(p) into v_kj from public.patients p where p.id = m.keep_id;
  select to_jsonb(p) into v_sj from public.patients p where p.id = m.source_id;
  if v_resume then
    v_kept := coalesce(m.filled_from_source, '{}');
  elsif not v_legacy then
    for f in select jsonb_object_keys(coalesce(m.fill_snapshot, '{}'::jsonb)) loop
      if f = any(k_fill) and (v_kj->f) = (m.fill_snapshot->f->'after') then
        v_revert := v_revert || f;
        v_before := v_before || jsonb_build_object(f, m.fill_snapshot->f->'before');
      else
        v_kept := v_kept || f;
      end if;
    end loop;
  else
    foreach f in array coalesce(m.filled_from_source, '{}'::text[]) loop
      if f = any(k_fill) and jsonb_typeof(v_kj->f) is distinct from 'null' and (v_kj->f) = (v_sj->f) then
        v_revert := v_revert || f;
        v_before := v_before || jsonb_build_object(f, null);
      else
        v_kept := v_kept || f;
      end if;
    end loop;
  end if;
  if cardinality(v_revert) > 0 then
    update public.patients p set
      middle_name = case when 'middle_name' = any(v_revert) then v_before->>'middle_name' else p.middle_name end,
      sex         = case when 'sex' = any(v_revert) then v_before->>'sex' else p.sex end,
      phone       = case when 'phone' = any(v_revert) then v_before->>'phone' else p.phone end,
      email       = case when 'email' = any(v_revert) then v_before->>'email' else p.email end,
      address     = case when 'address' = any(v_revert) then v_before->>'address' else p.address end,
      birthdate   = case when 'birthdate' = any(v_revert) then (v_before->>'birthdate')::date else p.birthdate end
     where p.id = m.keep_id;
  end if;

  -- (8) Restore the chain.
  with c as (update public.patients set merged_into_id = m.source_id
              where id = any(m.rechained) and merged_into_id = m.keep_id returning id)
  select coalesce(array_agg(id order by id), '{}') into v_rechained from c;

  -- (9) Consent cache for both.
  perform public.recompute_patient_consent_cache(m.source_id);
  perform public.recompute_patient_consent_cache(m.keep_id);

  -- Revert the repeat flag this merge set (F5), if the keep's own visit count
  -- (post move-back) no longer justifies it — count ALL visits, like the
  -- trigger and like the merge-side set above.
  if coalesce(m.context->>'repeat_flag_set', 'false') = 'true'
     and (select count(*) from public.visits v where v.patient_id = m.keep_id) <= 1 then
    update public.patients set is_repeat_patient = false
     where id = m.keep_id and is_repeat_patient;
    get diagnostics v_repeat_n = row_count;
    v_repeat_reverted := v_repeat_n > 0;
  end if;

  -- (10) Report + ledger + audit.
  v_left := jsonb_build_object(
    'visits', to_jsonb(array(select id from public.visits where id = any(v_mv_visits) and patient_id = m.keep_id order by id)),
    'appointments', to_jsonb(array(select id from public.appointments where id = any(v_mv_appts) and patient_id = m.keep_id order by id)),
    'audit_log', to_jsonb(array(select id from public.audit_log where id = any(v_mv_audit) and patient_id = m.keep_id order by id)),
    'critical_alerts', to_jsonb(array(select id from public.critical_alerts where id = any(v_mv_alerts) and patient_id = m.keep_id order by id)),
    'patient_consents', to_jsonb(array(select id from public.patient_consents where id = any(v_mv_consents) and patient_id = m.keep_id order by id)),
    'appointment_attachments', to_jsonb(array(select id from public.appointment_attachments where id = any(v_mv_attach) and patient_id = m.keep_id order by id)));
  v_report := jsonb_build_object(
    'merge_id', m.id, 'keep_id', m.keep_id, 'source_id', m.source_id,
    'kept_drm_id', v_keep.drm_id, 'source_drm_id', v_source.drm_id,
    'resumed_interrupted_undo', v_resume,
    'moved_back', jsonb_build_object(
      'visits', cardinality(v_b_visits), 'appointments', cardinality(v_b_appts),
      'audit_log', cardinality(v_b_audit), 'critical_alerts', cardinality(v_b_alerts),
      'patient_consents', cardinality(v_b_consents), 'appointment_attachments', cardinality(v_b_attach)),
    'left_on_keep', v_left,
    'kept_fields', to_jsonb(v_kept),
    'reverted_fields', to_jsonb(v_revert),
    'rechained_back', cardinality(v_rechained),
    'rechained_not_restored', to_jsonb(array(select id from unnest(m.rechained) id where id <> all(v_rechained))),
    'repeat_flag_reverted', v_repeat_reverted);

  update public.patient_merges
     set undone_at = now(), undone_by = p_actor, undo_report = v_report
   where id = m.id;

  insert into public.audit_log (actor_id, actor_type, patient_id, action, resource_type, resource_id,
                                metadata, ip_address, user_agent)
  values (p_actor, 'staff', m.keep_id, 'patient.merge.undone', 'patient', m.source_id,
          v_report, v_ip, left(nullif(p_context->>'user_agent', ''), 512));

  return v_report;
end;
$$;

-- ---------------------------------------------------------------------------
-- (8) Ownership + ACLs. PG17: the new owner needs CREATE on the schema at
-- transfer time — granted for these two statements only.
-- ---------------------------------------------------------------------------
grant create on schema public to patient_merge_writer;
alter function public.merge_patients_guarded(uuid, uuid, uuid, jsonb) owner to patient_merge_writer;
alter function public.undo_patient_merge_guarded(uuid, uuid, jsonb) owner to patient_merge_writer;
revoke create on schema public from patient_merge_writer;

revoke all on function public.merge_patients_guarded(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.undo_patient_merge_guarded(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.merge_patients_guarded(uuid, uuid, uuid, jsonb) to service_role;
grant execute on function public.undo_patient_merge_guarded(uuid, uuid, jsonb) to service_role;

-- 0184 revoked EXECUTE on its helpers from every role; a role granted TO
-- postgres does not inherit postgres's rights, so the writer needs its own.
grant execute on function public.lifecycle_lock(uuid[], boolean) to patient_merge_writer;
grant execute on function public.lifecycle_lock_results(uuid[], boolean) to patient_merge_writer;

-- ---------------------------------------------------------------------------
-- 0202's revokes, restated. On prod 0202 already ran, so these are no-ops;
-- on a FRESH replay 0196 runs before 0202, while Supabase's default
-- privileges still hand anon/authenticated full rights on these tables, and
-- the 0202-invariant post-condition below would abort the replay.
-- ---------------------------------------------------------------------------
revoke all on public.patient_merges, public.patient_consents from public, anon, authenticated;
revoke all on sequence public.patient_consents_seq_seq from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- (9) Post-conditions. A failure aborts the push; nothing is half-applied.
-- ---------------------------------------------------------------------------
do $assert$
declare
  n int;
begin
  if exists (select 1 from pg_roles where rolname = 'patient_merge_writer'
               and (rolcanlogin or rolinherit or rolbypassrls or rolsuper)) then
    raise exception '0196: patient_merge_writer must be NOLOGIN NOINHERIT NOBYPASSRLS';
  end if;
  if exists (select 1 from pg_auth_members am join pg_roles r on r.oid = am.member
              where am.roleid = 'patient_merge_writer'::regrole and r.rolname <> 'postgres') then
    raise exception '0196: patient_merge_writer is granted to a role other than postgres';
  end if;
  if exists (select 1 from pg_proc p
              where p.pronamespace = 'public'::regnamespace
                and p.proname in ('merge_patients_guarded', 'undo_patient_merge_guarded')
                and (pg_get_userbyid(p.proowner) <> 'patient_merge_writer' or not p.prosecdef)) then
    raise exception '0196: merge functions must be SECURITY DEFINER owned by patient_merge_writer';
  end if;
  if has_function_privilege('anon', 'public.merge_patients_guarded(uuid, uuid, uuid, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.merge_patients_guarded(uuid, uuid, uuid, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.undo_patient_merge_guarded(uuid, uuid, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.undo_patient_merge_guarded(uuid, uuid, jsonb)', 'execute')
     or not has_function_privilege('service_role', 'public.merge_patients_guarded(uuid, uuid, uuid, jsonb)', 'execute')
     or not has_function_privilege('service_role', 'public.undo_patient_merge_guarded(uuid, uuid, jsonb)', 'execute') then
    raise exception '0196: merge functions must be EXECUTE service_role only';
  end if;
  if has_schema_privilege('patient_merge_writer', 'public', 'create') then
    raise exception '0196: patient_merge_writer kept CREATE on public';
  end if;
  if not has_function_privilege('patient_merge_writer', 'public.lifecycle_lock(uuid[], boolean)', 'execute')
     or not has_function_privilege('patient_merge_writer', 'public.lifecycle_lock_results(uuid[], boolean)', 'execute')
     or not has_function_privilege('patient_merge_writer', 'public.recompute_patient_consent_cache(uuid)', 'execute') then
    raise exception '0196: patient_merge_writer is missing a helper EXECUTE grant';
  end if;
  if has_function_privilege('service_role', 'public.recompute_patient_consent_cache(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.recompute_patient_consent_cache(uuid)', 'execute')
     or has_function_privilege('anon', 'public.recompute_patient_consent_cache(uuid)', 'execute') then
    raise exception '0196: recompute_patient_consent_cache must not be callable by runtime roles';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_patients_live_merge_guard' and tgenabled = 'O') then
    raise exception '0196: trg_patients_live_merge_guard missing or disabled';
  end if;

  -- F2 (I2): a critical_alerts row's patient_id must always name the patient
  -- of its own test's visit. Prod holds 0 alerts today and 0184's (a2') check
  -- enforces this on INSERT / patient_id change, so only a pre-0184 row could
  -- be stale — this catches one before it reaches prod.
  select count(*) into n
    from public.critical_alerts ca
    join public.test_requests t on t.id = ca.test_request_id
    join public.visits v on v.id = t.visit_id
   where ca.patient_id is distinct from v.patient_id;
  if n > 0 then
    raise exception '0196: % critical alert(s) name a patient other than their test''s visit — reconcile before pushing', n;
  end if;

  -- F3 (I3): keep 0202's invariant standing for patient_merges / patient_consents
  -- — anon/authenticated hold NO privilege (table, column or owned sequence),
  -- and every policy on the two tables names only patient_merge_writer.
  if exists (
    select 1 from (values ('patient_merges'), ('patient_consents')) as t(rel)
    cross join (values ('anon'), ('authenticated')) as r(rolname)
    where has_table_privilege(r.rolname, ('public.' || t.rel)::regclass,
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
       or has_any_column_privilege(r.rolname, ('public.' || t.rel)::regclass, 'SELECT,INSERT,UPDATE,REFERENCES')
  ) then
    raise exception '0196: anon/authenticated hold a privilege on patient_merges or patient_consents';
  end if;
  if has_sequence_privilege('anon', 'public.patient_consents_seq_seq', 'USAGE,SELECT,UPDATE')
     or has_sequence_privilege('authenticated', 'public.patient_consents_seq_seq', 'USAGE,SELECT,UPDATE') then
    raise exception '0196: anon/authenticated hold a privilege on patient_consents_seq_seq';
  end if;
  if exists (
    select 1 from pg_policy p
     where p.polrelid in ('public.patient_merges'::regclass, 'public.patient_consents'::regclass)
       and p.polroles <> array['patient_merge_writer'::regrole::oid]
  ) then
    raise exception '0196: a policy on patient_merges or patient_consents names a role other than patient_merge_writer';
  end if;

  -- The consent fold must reproduce every patient's cached state (spec R4):
  -- if it did not, re-running it on a merge would silently rewrite consent.
  with recursive ev as (
    select c.patient_id, c.event_type, c.consent_scope, c.created_at, c.method, c.notice_version,
           row_number() over (partition by c.patient_id order by c.seq) as rn
      from public.patient_consents c
  ), f as (
    select p.id as pid, 0::bigint as rn, false as cur, null::timestamptz as signed,
           null::timestamptz as wd, null::text as meth, null::text as nv
      from public.patients p
    union all
    select f.pid, e.rn,
           (e.event_type = 'granted' and e.consent_scope = 'full'),
           case when e.event_type = 'granted' and e.consent_scope = 'full' then e.created_at
                when e.event_type = 'granted' then null else f.signed end,
           case when e.event_type = 'granted' then null else e.created_at end,
           case when e.event_type = 'granted' and e.consent_scope = 'full' then e.method
                when e.event_type = 'granted' then null else f.meth end,
           case when e.event_type = 'granted' and e.consent_scope = 'full' then e.notice_version
                when e.event_type = 'granted' then null else f.nv end
      from f join ev e on e.patient_id = f.pid and e.rn = f.rn + 1
  ), last as (
    select distinct on (pid) * from f order by pid, rn desc
  )
  select count(*) into n
    from last l join public.patients p on p.id = l.pid
   where (l.cur, l.signed, l.wd, l.meth, l.nv)
         is distinct from (p.consent_current, p.consent_signed_at, p.consent_withdrawn_at,
                           p.consent_method, p.consent_notice_version);
  if n > 0 then
    raise exception '0196: % patient(s) have a consent cache that differs from their event history', n;
  end if;
end
$assert$;

reset lock_timeout;
