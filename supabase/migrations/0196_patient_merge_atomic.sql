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
