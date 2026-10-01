-- =============================================================================
-- 0197_merge_marker_enforcement_smoke.sql
-- =============================================================================
-- LOCAL ONLY. Run after 0197 is applied:
--   /opt/homebrew/opt/libpq/bin/psql postgresql://postgres:postgres@127.0.0.1:54322/postgres \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0197_merge_marker_enforcement_smoke.sql
--
-- BEGIN … ROLLBACK; leaves no rows behind. Proves the merge-marker guard:
--   b1–b6   nobody but patient_merge_writer moves a marker, and the writer only
--           through a legal transition (both fields, nothing else changed)
--   b7–b11  the 0196 functions still merge and undo; a merged row refuses
--           edits (P0058) but takes bookkeeping and no-op updates
--   b12–b16 re-parent keeps merged_at; deleted rows stay refused by 0167's
--           guard first; the superseded 0196 guard is gone
-- The full merge/undo behaviour under this guard is the 0196 smoke, re-run
-- after 0197 is applied.
-- =============================================================================

begin;

do $guard$
begin
  if (select count(*) from public.patients) > 5000 then
    raise exception 'refusing: % patients looks like prod — this test is LOCAL ONLY',
      (select count(*) from public.patients);
  end if;
end
$guard$;

-- --- Shared fixture -----------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values
  ('a0000000-0000-4000-8000-000000000197', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'mm-admin@example.test', '', now(), now(), now());

insert into public.staff_profiles (id, full_name, role, is_active)
values ('a0000000-0000-4000-8000-000000000197', 'MM Admin', 'admin', true);

-- --- Helpers (pg_temp: vanish with the session) ---------------------------------
create function pg_temp.mk_patient(tag text, phone text default null, email text default null,
                                   bdate date default '1990-01-01') returns uuid language sql as $f$
  insert into public.patients (drm_id, first_name, last_name, birthdate, phone, email)
  values ('DRM-MM' || tag, 'Smoke', 'Mm' || tag, bdate, phone, email)
  returning id;
$f$;

create function pg_temp.mk_visit(p uuid) returns uuid language sql as $f$
  insert into public.visits (visit_number, patient_id, payment_status, total_php, paid_php)
  values ('V-MM-' || substr(md5(random()::text), 1, 10), p, 'unpaid', 0, 0)
  returning id;
$f$;

create function pg_temp.mark_merged(src uuid, keep uuid) returns void language plpgsql as $f$
begin
  set local role patient_merge_writer;
  update public.patients set merged_into_id = keep, merged_at = now() where id = src;
  reset role;
end $f$;

-- Deletes a patient without the blocker check (same mechanism as 0184's smoke).
create function pg_temp.kill(p uuid) returns void language plpgsql as $f$
begin
  set local role patient_lifecycle_writer;
  update public.patients
     set deleted_at = now(), deleted_by = 'a0000000-0000-4000-8000-000000000197', delete_reason = 'test_record'
   where id = p;
  reset role;
end $f$;

create function pg_temp.merge(keep uuid, src uuid,
                              actor uuid default 'a0000000-0000-4000-8000-000000000197',
                              ctx jsonb default '{"source":"admin","ip":"127.0.0.1","user_agent":"smoke"}')
returns jsonb language plpgsql as $f$
declare r jsonb;
begin
  set local role service_role;
  r := public.merge_patients_guarded(keep, src, actor, ctx);
  reset role;
  return r;
end $f$;

create function pg_temp.undo(mid uuid, actor uuid default 'a0000000-0000-4000-8000-000000000197')
returns jsonb language plpgsql as $f$
declare r jsonb;
begin
  set local role service_role;
  r := public.undo_patient_merge_guarded(mid, actor, '{"ip":"127.0.0.1","user_agent":"smoke"}'::jsonb);
  reset role;
  return r;
end $f$;

create function pg_temp.expect(label text, got text, want text) returns void language plpgsql as $f$
begin
  if got is distinct from want then
    raise exception '0197 % FAILED: got [%], want [%]', label, got, want;
  end if;
  raise notice '0197 % OK', label;
end $f$;

-- Runs sql as postgres; returns the SQLSTATE it raised, or 'ok'.
create function pg_temp.state_of(sql text) returns text language plpgsql as $f$
declare s text;
begin
  execute sql;
  return 'ok';
exception when others then
  get stacked diagnostics s = returned_sqlstate;
  return s;
end $f$;

-- Runs sql as role r; returns the SQLSTATE it raised, or 'ok'. The exception
-- block's subtransaction rollback also reverts the SET LOCAL ROLE.
create function pg_temp.state_as(r text, sql text) returns text language plpgsql as $f$
declare s text;
begin
  execute format('set local role %I', r);
  execute sql;
  reset role;
  return 'ok';
exception when others then
  get stacked diagnostics s = returned_sqlstate;
  return s;
end $f$;

-- The five cached consent columns as one comparable string.
-- b ----------------------------------------------------------------------------
do $b$
declare k uuid; s uuid; t uuid; x uuid; mid uuid;
begin
  k := pg_temp.mk_patient('B1K'); s := pg_temp.mk_patient('B1S'); x := pg_temp.mk_patient('B1X');
  perform pg_temp.expect('b1 service_role cannot set a merge marker',
    pg_temp.state_as('service_role', format('update public.patients set merged_into_id = %L, merged_at = now() where id = %L', k, s)), 'P0080');
  perform pg_temp.expect('b2 postgres cannot either',
    pg_temp.state_of(format('update public.patients set merged_into_id = %L, merged_at = now() where id = %L', k, s)), 'P0080');
  perform pg_temp.expect('b3 a patient cannot be created already merged',
    pg_temp.state_of(format($q$insert into public.patients (drm_id, first_name, last_name, birthdate, merged_into_id, merged_at) values ('DRM-MMB1Z', 'Z', 'Z', '1990-01-01', %L, now())$q$, k)), 'P0080');
  perform pg_temp.expect('b3b nor created with only merged_at set',
    pg_temp.state_of($q$insert into public.patients (drm_id, first_name, last_name, birthdate, merged_at) values ('DRM-MMB1Y', 'Y', 'Y', '1990-01-01', now())$q$), 'P0080');
  perform pg_temp.expect('b4 writer: marker without merged_at refused',
    pg_temp.state_as('patient_merge_writer', format('update public.patients set merged_into_id = %L where id = %L', k, s)), 'P0080');
  perform pg_temp.expect('b5 writer: merged_at alone refused',
    pg_temp.state_as('patient_merge_writer', format('update public.patients set merged_at = now() where id = %L', s)), 'P0080');
  -- Backstop, not this guard: the lifecycle writer has no column grant on the
  -- markers, so the privilege check (42501) fires before any trigger.
  perform pg_temp.expect('b6 lifecycle writer cannot set markers',
    (pg_temp.state_as('patient_lifecycle_writer', format('update public.patients set merged_into_id = %L, merged_at = now() where id = %L', k, s))
      in ('42501', 'P0080'))::text, 'true');
  perform pg_temp.expect('b6b writer: a merge that also changes another field is refused',
    pg_temp.state_as('patient_merge_writer', format('update public.patients set merged_into_id = %L, merged_at = now(), phone = %L where id = %L', k, '09170000000', s)), 'P0080');
  perform pg_temp.mk_visit(s);
  mid := (pg_temp.merge(k, s)->>'merge_id')::uuid;
  perform pg_temp.expect('b7 the merge function still works', (select merged_into_id from public.patients where id = s)::text, k::text);
  perform pg_temp.expect('b8 editing a merged record is refused',
    pg_temp.state_as('service_role', format('update public.patients set phone = %L where id = %L', '09170000000', s)), 'P0058');
  perform pg_temp.expect('b8b the P0058 refusal does not depend on the role: postgres',
    pg_temp.state_of(format('update public.patients set phone = %L where id = %L', '09170000000', s)), 'P0058');
  perform pg_temp.expect('b8c … nor the merge writer',
    pg_temp.state_as('patient_merge_writer', format('update public.patients set phone = %L where id = %L', '09170000000', s)), 'P0058');
  perform pg_temp.expect('b8d writer: a re-parent that also changes another field is refused',
    pg_temp.state_as('patient_merge_writer', format('update public.patients set merged_into_id = %L, phone = %L where id = %L', x, '09170000000', s)), 'P0080');
  perform pg_temp.expect('b8e writer: an un-merge that also changes another field is refused',
    pg_temp.state_as('patient_merge_writer', format('update public.patients set merged_into_id = null, merged_at = null, phone = %L where id = %L', '09170000000', s)), 'P0080');
  perform pg_temp.expect('b9 a bookkeeping-only touch of a merged record is allowed',
    pg_temp.state_as('service_role', format('update public.patients set updated_at = clock_timestamp() where id = %L', s)), 'ok');
  perform pg_temp.expect('b9b a no-op update of a merged record is allowed',
    pg_temp.state_as('service_role', format('update public.patients set first_name = first_name where id = %L', s)), 'ok');
  perform pg_temp.expect('b10 service_role cannot un-merge directly',
    pg_temp.state_as('service_role', format('update public.patients set merged_into_id = null, merged_at = null where id = %L', s)), 'P0080');
  perform pg_temp.expect('b10b writer: an un-merge that keeps merged_at is refused',
    pg_temp.state_as('patient_merge_writer', format('update public.patients set merged_into_id = null where id = %L', s)), 'P0080');
  perform pg_temp.expect('b10c writer: re-pointing with a new merge time is refused',
    pg_temp.state_as('patient_merge_writer', format($q$update public.patients set merged_into_id = %L, merged_at = merged_at + interval '1 minute' where id = %L$q$, x, s)), 'P0080');
  perform pg_temp.undo(mid);
  perform pg_temp.expect('b11 the undo function still works', coalesce((select merged_into_id from public.patients where id = s)::text, 'null'), 'null');
  -- chain re-parent by the writer keeps merged_at
  t := pg_temp.mk_patient('B1T');
  perform pg_temp.mark_merged(t, s);
  perform pg_temp.expect('b12 writer re-parent (merged_at unchanged) allowed',
    pg_temp.state_as('patient_merge_writer', format('update public.patients set merged_into_id = %L where id = %L', x, t)), 'ok');
  perform pg_temp.kill(x);
  -- 0167's trg_patients_lifecycle_guard fires first (name order) and refuses
  -- any change to a deleted row, so this guard's own deleted_at arm is only a
  -- backstop.
  perform pg_temp.expect('b13 a deleted record cannot be merged, even by the writer',
    pg_temp.state_as('patient_merge_writer', format('update public.patients set merged_into_id = %L, merged_at = now() where id = %L', k, x)), 'P0058');
  perform pg_temp.expect('b14 the superseded 0196 guard is gone',
    ((select count(*) from pg_trigger where tgname = 'trg_patients_live_merge_guard')
     + (select count(*) from pg_proc where proname in ('guard_live_merge_marker', 'patient_has_live_v2_merge')))::text, '0');
  perform pg_temp.expect('b15 the guard is invoker-only and closed to runtime roles',
    ((select prosecdef from pg_proc where oid = 'public.enforce_merge_marker()'::regprocedure)
     or has_function_privilege('anon', 'public.enforce_merge_marker()', 'execute')
     or has_function_privilege('authenticated', 'public.enforce_merge_marker()', 'execute')
     or has_function_privilege('service_role', 'public.enforce_merge_marker()', 'execute'))::text, 'false');
end $b$;

rollback;
