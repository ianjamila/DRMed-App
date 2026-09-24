-- =============================================================================
-- 0170_sheet_sync_foundation.sql
-- =============================================================================
-- Sheet Sync PR 1 — spec docs/superpowers/specs/2026-09-24-sheet-sync-and-
-- patient-sources-design.md §4–§5, plan docs/superpowers/plans/2026-09-24-
-- sheet-sync-pr1.md (decisions D1–D5).
--
--  1. referral_sources: channel_group + six channels (family_friends,
--     walk_in_signage, phone_text_viber, partner_corporate, flyers,
--     prefer_not_to_say).
--  2. patients.referral_source_origin ('staff'|'patient'|'sheet') and
--     patients.row_version. Every existing non-NULL source starts 'staff'
--     (unproven provenance ⇒ staff-owned), except a public-form answer
--     written since 0158 (pre_registered, created on/after 2026-09-24 Manila),
--     which is the patient's own and starts 'patient'. A BEFORE trigger owns both columns:
--     row_version increments on every UPDATE; the origin can only be set
--     through the transaction-local setting app.referral_origin, which only
--     the security-definer functions below set (PostgREST cannot call
--     set_config). Any other change to referral_source is a staff change.
--  3. resolve_patient_guarded (0158) re-created to stamp 'patient'.
--  4. Control tables (settings seeded PAUSED, runs with a lease, review
--     items, before-images, identity decisions, acquisition facts, aliases)
--     and reporting-only mirror tables + a staging table.
--  5. Lease-fenced RPCs, all SECURITY DEFINER, search_path '', service_role
--     only. P0062 = another sync holds the lease (or, for a review resolve,
--     a real sync is mid-run); P0063 = this worker's lease was taken over;
--     P0064 = review item no longer open. A preview (dry-run) lease may only
--     heartbeat and finish — every other write raises 22023.
--  6. Identity decisions (sheet_patient_links) are link / create / review.
--     "review" is a HOLD: no patient, and the sync never auto-decides that
--     key again. Undoing a run turns its auto links (and the links of a
--     patient the undo deletes) into holds, so an undo sticks instead of the
--     next nightly run re-deriving the same link.
-- Nothing here creates visits, payments or journal entries.
-- =============================================================================

-- 1. Channels ---------------------------------------------------------------
alter table public.referral_sources
  add column channel_group text not null default 'other'
    constraint referral_sources_channel_group_check
    check (channel_group in ('online','walk_in','referral','direct_contact','partner','returning','other'));

insert into public.referral_sources (id, label, sort_order) values
  ('family_friends',     'Family / friends',              25),
  ('walk_in_signage',    'Walk-in (saw poster/signage)',  85),
  ('phone_text_viber',   'Phone call / text / Viber',     95),
  ('partner_corporate',  'Partner / corporate',          105),
  ('flyers',             'Flyers',                       112),
  ('prefer_not_to_say',  'Prefer not to say',            115)
on conflict (id) do nothing;

update public.referral_sources set channel_group = case id
  when 'online_facebook' then 'online'   when 'online_google' then 'online'
  when 'online_website' then 'online'    when 'online_instagram' then 'online'
  when 'online_tiktok' then 'online'
  when 'walk_in' then 'walk_in'          when 'walk_in_signage' then 'walk_in'
  when 'doctor_referral' then 'referral' when 'customer_referral' then 'referral'
  when 'family_friends' then 'referral'
  when 'phone_text_viber' then 'direct_contact'
  when 'partner_corporate' then 'partner' when 'tenant_employee_northridge' then 'partner'
  when 'returning_patient' then 'returning'
  else 'other' end
where true;

-- 2. Ownership + row_version -------------------------------------------------
alter table public.patients
  add column referral_source_origin text,
  add column row_version bigint not null default 0;

-- Backfill without touching updated_at (it feeds "recently updated" surfaces).
alter table public.patients disable trigger trg_patients_updated_at;
update public.patients set referral_source_origin = 'staff' where referral_source is not null;
-- 0158 (live 2026-09-24) lets /schedule and /register write the patient's own
-- answer through resolve_patient_guarded, which only ever creates
-- pre_registered rows. Those answers are patient-owned, not staff-owned.
update public.patients set referral_source_origin = 'patient'
 where pre_registered and referral_source is not null
   and created_at >= timestamptz '2026-09-24 00:00+08';
alter table public.patients enable trigger trg_patients_updated_at;

alter table public.patients
  add constraint patients_referral_source_origin_check
    check (referral_source_origin in ('staff','patient','sheet')),
  add constraint patients_referral_source_origin_pairs
    check ((referral_source is null) = (referral_source_origin is null));

create or replace function public.patients_referral_origin_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_writer text := nullif(current_setting('app.referral_origin', true), '');
begin
  if tg_op = 'UPDATE' then
    new.row_version := old.row_version + 1;
    if new.referral_source is distinct from old.referral_source then
      new.referral_source_origin := case when new.referral_source is null then null
                                         else coalesce(v_writer, 'staff') end;
    else
      new.referral_source_origin := old.referral_source_origin;
    end if;
  else
    new.row_version := 0;
    new.referral_source_origin := case when new.referral_source is null then null
                                       else coalesce(v_writer, 'staff') end;
  end if;
  return new;
end;
$$;

create trigger trg_patients_referral_origin
  before insert or update on public.patients
  for each row execute function public.patients_referral_origin_guard();

revoke all on function public.patients_referral_origin_guard() from public;
revoke execute on function public.patients_referral_origin_guard() from anon, authenticated;

-- 3. resolve_patient_guarded (0158) — same body, stamps origin 'patient' -----
create or replace function public.resolve_patient_guarded(
  p_email text, p_last_name text, p_birthdate date, p_fields jsonb
)
returns table (id uuid, drm_id text, reused boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v record;
begin
  perform pg_advisory_xact_lock(
    hashtext('patient_resolve:' || lower(p_email) || ':' || lower(p_last_name) || ':' || p_birthdate::text)
  );
  select p.id, p.drm_id into v
    from public.patients p
   where p.email = lower(p_email) and p.last_name = p_last_name and p.birthdate = p_birthdate
   limit 1;
  if found then
    return query select v.id, v.drm_id, true;
    return;
  end if;
  perform set_config('app.referral_origin', 'patient', true);
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
  perform set_config('app.referral_origin', '', true);
end;
$$;

revoke all on function public.resolve_patient_guarded(text, text, date, jsonb) from public;
revoke execute on function public.resolve_patient_guarded(text, text, date, jsonb) from anon, authenticated;
grant execute on function public.resolve_patient_guarded(text, text, date, jsonb) to service_role;

-- 4. Tables ------------------------------------------------------------------
create table public.sheet_sync_settings (
  id                  boolean primary key default true,
  paused              boolean not null default true,
  paused_at           timestamptz,
  paused_by           uuid references auth.users(id),
  pause_reason        text,
  mirror_window_start date not null default date '2026-05-26',
  final_synced_at     timestamptz,
  converted_at        timestamptz,
  updated_at          timestamptz not null default now(),
  constraint sheet_sync_settings_singleton check (id = true),
  constraint sheet_sync_settings_reason_len check (pause_reason is null or char_length(pause_reason) <= 400)
);
insert into public.sheet_sync_settings (id, paused, paused_at) values (true, true, now())
on conflict (id) do nothing;

create table public.sheet_sync_runs (
  id                    uuid primary key default gen_random_uuid(),
  trigger               text not null check (trigger in ('cron','manual','cli','resort','alias','revert')),
  actor_id              uuid references auth.users(id),
  dry_run               boolean not null default false,
  status                text not null check (status in ('running','succeeded','partial','failed','skipped_paused')),
  lease_token           uuid unique,
  heartbeat_at          timestamptz,
  started_at            timestamptz not null default now(),
  ended_at              timestamptz,
  per_tab               jsonb not null default '{}'::jsonb,
  summary               jsonb not null default '{}'::jsonb,
  error                 text,
  legacy_import_run_id  uuid references public.legacy_import_runs(id),
  reverted_by_run_id    uuid references public.sheet_sync_runs(id)
);
create unique index sheet_sync_runs_one_running on public.sheet_sync_runs ((status)) where status = 'running';
create index sheet_sync_runs_started on public.sheet_sync_runs (started_at desc, id);

create table public.sheet_sync_review_items (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid references public.sheet_sync_runs(id) on delete set null,
  tab            text not null check (tab in ('customers','lab','consult')),
  item_key       text not null,
  kind           text not null check (kind in ('ambiguous_patient','identity_conflict','possible_existing_patient',
                                               'unmapped_source','unparseable_date','invalid_row','suspect_snapshot')),
  payload        jsonb not null default '{}'::jsonb,
  status         text not null default 'open' check (status in ('open','resolved','dismissed')),
  resolution     jsonb,
  resolved_by    uuid references auth.users(id),
  resolved_at    timestamptz,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now()
);
create unique index sheet_sync_review_items_open_key on public.sheet_sync_review_items (kind, item_key) where status = 'open';
create index sheet_sync_review_items_list on public.sheet_sync_review_items (status, kind, last_seen_at desc, id);

-- Before-images. No FK to patients: the history must outlive a reverted create.
create table public.sheet_sync_changes (
  id                 bigint generated always as identity primary key,
  run_id             uuid not null references public.sheet_sync_runs(id),
  patient_id         uuid not null,
  change_kind        text not null check (change_kind in ('update','create')),
  column_name        text,
  old_value          text,
  new_value          text,
  row_version_after  bigint not null,
  changed_at         timestamptz not null default now(),
  reverted_at        timestamptz,
  constraint sheet_sync_changes_update_has_column check ((change_kind = 'create') = (column_name is null))
);
create index sheet_sync_changes_run on public.sheet_sync_changes (run_id, patient_id);

-- decision: link (patient_id set) | create (admin: make a new patient) |
-- review (a HOLD: no patient; every run sends the key to review until an
-- admin resolves it). run_id = the sync run that last wrote the decision
-- (create / link / hold ops and undo); an admin resolve leaves it NULL.
create table public.sheet_patient_links (
  link_key    text primary key,
  patient_id  uuid references public.patients(id) on delete cascade,
  decision    text not null default 'link' check (decision in ('link','create','review')),
  method      text not null check (method in ('auto_exact','auto_loose','admin')),
  decided_by  uuid references auth.users(id),
  decided_at  timestamptz not null default now(),
  run_id      uuid references public.sheet_sync_runs(id) on delete set null,
  constraint sheet_patient_links_target check ((decision = 'link') = (patient_id is not null))
);
create index sheet_patient_links_patient on public.sheet_patient_links (patient_id);
create index sheet_patient_links_run on public.sheet_patient_links (run_id);

create table public.patient_acquisition_facts (
  patient_id        uuid primary key references public.patients(id) on delete cascade,
  registered_on     date,
  sheet_new_repeat  text check (sheet_new_repeat in ('new','repeat')),
  source_ref        text,
  updated_at        timestamptz not null default now()
);

create table public.referral_source_aliases (
  raw_normalized      text primary key,
  referral_source_id  text not null references public.referral_sources(id),
  created_by          uuid references auth.users(id),
  created_at          timestamptz not null default now()
);

create table public.sheet_customer_rows (
  id                  bigint generated always as identity primary key,
  sheet_row           int not null,
  source_key          text not null unique,
  dup_count           int not null default 1,
  full_name_raw       text not null,
  name_norm           text not null,
  loose_key           text not null,
  link_key            text not null,
  phone_norm          text,
  dob                 date,
  registered_on       date,
  source_raw          text not null default '',
  source_norm         text not null default '',
  referral_source_id  text references public.referral_sources(id),
  referred_by_raw     text,
  new_repeat          text check (new_repeat in ('new','repeat')),
  release_medium_raw  text,
  patient_id          uuid references public.patients(id) on delete set null,
  link_state          text not null check (link_state in ('linked','ambiguous','conflict','possible_existing','unlinked')),
  row_hash            text not null,
  run_id              uuid not null references public.sheet_sync_runs(id)
);
create index sheet_customer_rows_patient on public.sheet_customer_rows (patient_id);
create index sheet_customer_rows_loose on public.sheet_customer_rows (loose_key);
create index sheet_customer_rows_source_norm on public.sheet_customer_rows (source_norm);

create table public.sheet_encounter_lines (
  id                  bigint generated always as identity primary key,
  tab                 text not null check (tab in ('lab','consult','procedure_hmo','home_service')),
  sheet_row           int not null,
  service_date        date not null,
  name_raw            text not null,
  name_norm           text not null,
  loose_key           text not null,
  patient_id          uuid references public.patients(id) on delete set null,
  identity_key        text not null,
  service_raw         text,
  doctor_raw          text,
  hmo_raw             text,
  base_php            numeric(12,2),
  final_php           numeric(12,2),
  clinic_fee_php      numeric(12,2),
  revenue_php         numeric(12,2),
  payment_method_raw  text,
  payment_detail_raw  text,
  release_medium_raw  text,
  released_on         date,
  control_no          text,
  test_no             text,
  raw                 jsonb not null,
  row_hash            text not null,
  run_id              uuid not null references public.sheet_sync_runs(id)
);
create index sheet_encounter_lines_date on public.sheet_encounter_lines (service_date, tab);
create index sheet_encounter_lines_identity on public.sheet_encounter_lines (identity_key, service_date);
create index sheet_encounter_lines_patient on public.sheet_encounter_lines (patient_id);

create table public.sheet_mirror_staging (
  seq     bigint generated always as identity primary key,
  run_id  uuid not null references public.sheet_sync_runs(id) on delete cascade,
  tab     text not null check (tab in ('customers','lab','consult')),
  row     jsonb not null,
  staged_at timestamptz not null default now()
);
create index sheet_mirror_staging_run on public.sheet_mirror_staging (run_id, tab, seq);

-- RLS: admin read on everything an admin page shows; no write policies
-- (all writes go through the service-role RPCs below). Staging: no policy.
do $$
declare t text;
begin
  foreach t in array array['sheet_sync_settings','sheet_sync_runs','sheet_sync_review_items','sheet_sync_changes',
    'sheet_patient_links','patient_acquisition_facts','referral_source_aliases','sheet_customer_rows',
    'sheet_encounter_lines','sheet_mirror_staging'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke all on public.%I from authenticated', t);
  end loop;
  foreach t in array array['sheet_sync_settings','sheet_sync_runs','sheet_sync_review_items','sheet_sync_changes',
    'sheet_patient_links','patient_acquisition_facts','referral_source_aliases','sheet_customer_rows',
    'sheet_encounter_lines'] loop
    execute format('grant select on public.%I to authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select public.has_role(array[''admin''])))',
                   t || ': admin read', t);
  end loop;
end $$;

-- seed-grant-parity.test.ts reads `revoke … on public.<name> from …` by
-- regex. Revokes built with format() inside the do block above are invisible
-- to it, which leaves the seed tail unchecked. So below, also write the
-- twenty revokes and nine grants literally (they are idempotent).
revoke all on public.sheet_sync_settings from anon;
revoke all on public.sheet_sync_settings from authenticated;
grant select on public.sheet_sync_settings to authenticated;

revoke all on public.sheet_sync_runs from anon;
revoke all on public.sheet_sync_runs from authenticated;
grant select on public.sheet_sync_runs to authenticated;

revoke all on public.sheet_sync_review_items from anon;
revoke all on public.sheet_sync_review_items from authenticated;
grant select on public.sheet_sync_review_items to authenticated;

revoke all on public.sheet_sync_changes from anon;
revoke all on public.sheet_sync_changes from authenticated;
grant select on public.sheet_sync_changes to authenticated;

revoke all on public.sheet_patient_links from anon;
revoke all on public.sheet_patient_links from authenticated;
grant select on public.sheet_patient_links to authenticated;

revoke all on public.patient_acquisition_facts from anon;
revoke all on public.patient_acquisition_facts from authenticated;
grant select on public.patient_acquisition_facts to authenticated;

revoke all on public.referral_source_aliases from anon;
revoke all on public.referral_source_aliases from authenticated;
grant select on public.referral_source_aliases to authenticated;

revoke all on public.sheet_customer_rows from anon;
revoke all on public.sheet_customer_rows from authenticated;
grant select on public.sheet_customer_rows to authenticated;

revoke all on public.sheet_encounter_lines from anon;
revoke all on public.sheet_encounter_lines from authenticated;
grant select on public.sheet_encounter_lines to authenticated;

revoke all on public.sheet_mirror_staging from anon;
revoke all on public.sheet_mirror_staging from authenticated;

-- 5. RPCs --------------------------------------------------------------------
-- The fence: proves the caller still holds the lease and stamps a heartbeat.
-- p_write = false only for heartbeat/finish; every other RPC passes true,
-- which a preview (dry-run) lease can never satisfy.
create or replace function public._sheet_sync_fence(p_lease_token uuid, p_write boolean default true)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_dry boolean;
begin
  select r.id, r.dry_run into v_id, v_dry from public.sheet_sync_runs r
   where r.lease_token = p_lease_token and r.status = 'running'
   for update;
  if v_id is null then
    raise exception 'This sheet sync lost its turn to another run.' using errcode = 'P0063';
  end if;
  if coalesce(p_write, true) and v_dry then
    raise exception 'A preview run cannot change data.' using errcode = '22023';
  end if;
  update public.sheet_sync_runs set heartbeat_at = now() where id = v_id;
  return v_id;
end $$;

-- Records one before-image row per changed column (allow-listed).
create or replace function public._sheet_sync_record_changes(p_run uuid, p_old jsonb, p_new jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  insert into public.sheet_sync_changes (run_id, patient_id, change_kind, column_name, old_value, new_value, row_version_after)
  select p_run, (p_new->>'id')::uuid, 'update', c, p_old->>c, p_new->>c, (p_new->>'row_version')::bigint
    from unnest(array['phone','email','birthdate','sex','address','referred_by_doctor','preferred_release_medium',
                      'senior_pwd_id_kind','senior_pwd_id_number','referral_source','referral_source_origin']) c
   where (p_old->c) is distinct from (p_new->c);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function public.sheet_sync_acquire(p_trigger text, p_actor uuid, p_dry_run boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_paused boolean;
  v_run public.sheet_sync_runs%rowtype;
  v_id uuid;
  v_token uuid := gen_random_uuid();
begin
  if p_trigger is null or p_trigger not in ('cron','manual','cli','resort','alias','revert') then
    raise exception 'Unknown sheet sync trigger.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('sheet_sync_lease'));
  select s.paused into v_paused from public.sheet_sync_settings s where s.id;
  if coalesce(v_paused, true) and p_trigger in ('cron','manual','cli') and not coalesce(p_dry_run, false) then
    insert into public.sheet_sync_runs (trigger, actor_id, dry_run, status, ended_at)
    values (p_trigger, p_actor, false, 'skipped_paused', now())
    returning id into v_id;
    return jsonb_build_object('status', 'skipped_paused', 'run_id', v_id);
  end if;
  select * into v_run from public.sheet_sync_runs r where r.status = 'running' for update;
  if found then
    if v_run.heartbeat_at > now() - interval '10 minutes' then
      raise exception 'Another sheet sync is running.' using errcode = 'P0062';
    end if;
    update public.sheet_sync_runs set status = 'failed', ended_at = now(), error = 'lease expired (no heartbeat for 10 minutes)'
     where id = v_run.id;
  end if;
  insert into public.sheet_sync_runs (trigger, actor_id, dry_run, status, lease_token, heartbeat_at)
  values (p_trigger, p_actor, coalesce(p_dry_run, false), 'running', v_token, now())
  returning id into v_id;
  return jsonb_build_object('status', 'running', 'run_id', v_id, 'lease_token', v_token);
end $$;

create or replace function public.sheet_sync_heartbeat(p_lease_token uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public._sheet_sync_fence(p_lease_token, false);
end $$;

create or replace function public.sheet_sync_finish(
  p_lease_token uuid, p_status text, p_per_tab jsonb, p_summary jsonb, p_error text
) returns void language plpgsql security definer set search_path = '' as $$
declare v_id uuid := public._sheet_sync_fence(p_lease_token, false);
begin
  if p_status not in ('succeeded','partial','failed') then
    raise exception 'Unknown sheet sync status.' using errcode = '22023';
  end if;
  update public.sheet_sync_runs
     set status = p_status, ended_at = now(), per_tab = coalesce(p_per_tab, '{}'::jsonb),
         summary = coalesce(p_summary, '{}'::jsonb), error = p_error
   where id = v_id;
  delete from public.sheet_mirror_staging where run_id = v_id;
end $$;

create or replace function public.sheet_mirror_stage(p_lease_token uuid, p_tab text, p_rows jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_id uuid := public._sheet_sync_fence(p_lease_token, true); v_n integer;
begin
  if p_tab not in ('customers','lab','consult') or jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'Bad staging chunk.' using errcode = '22023';
  end if;
  insert into public.sheet_mirror_staging (run_id, tab, row)
  select v_id, p_tab, e from jsonb_array_elements(p_rows) e;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Snapshot-replaces one mirror tab from this run's staged rows. p_expected is
-- the row count the worker staged; a mismatch (a lost or doubled chunk)
-- raises, which rolls back the delete too — the live mirror is untouched.
create or replace function public.sheet_mirror_commit(p_lease_token uuid, p_tab text, p_expected integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_id uuid := public._sheet_sync_fence(p_lease_token, true); v_n integer;
begin
  if p_tab = 'customers' then
    delete from public.sheet_customer_rows where true;
    insert into public.sheet_customer_rows (sheet_row, source_key, dup_count, full_name_raw, name_norm, loose_key,
      link_key, phone_norm, dob, registered_on, source_raw, source_norm, referral_source_id, referred_by_raw,
      new_repeat, release_medium_raw, patient_id, link_state, row_hash, run_id)
    select r.sheet_row, r.source_key, r.dup_count, r.full_name_raw, r.name_norm, r.loose_key, r.link_key,
           r.phone_norm, r.dob, r.registered_on, r.source_raw, r.source_norm, r.referral_source_id, r.referred_by_raw,
           r.new_repeat, r.release_medium_raw, r.patient_id, r.link_state, r.row_hash, v_id
      from public.sheet_mirror_staging s
     cross join lateral jsonb_populate_record(null::public.sheet_customer_rows, s.row) r
     where s.run_id = v_id and s.tab = 'customers'
     order by s.seq;
  elsif p_tab in ('lab','consult') then
    delete from public.sheet_encounter_lines where tab = p_tab;
    insert into public.sheet_encounter_lines (tab, sheet_row, service_date, name_raw, name_norm, loose_key, patient_id,
      identity_key, service_raw, doctor_raw, hmo_raw, base_php, final_php, clinic_fee_php, revenue_php,
      payment_method_raw, payment_detail_raw, release_medium_raw, released_on, control_no, test_no, raw, row_hash, run_id)
    select p_tab, r.sheet_row, r.service_date, r.name_raw, r.name_norm, r.loose_key, r.patient_id, r.identity_key,
           r.service_raw, r.doctor_raw, r.hmo_raw, r.base_php, r.final_php, r.clinic_fee_php, r.revenue_php,
           r.payment_method_raw, r.payment_detail_raw, r.release_medium_raw, r.released_on, r.control_no, r.test_no,
           r.raw, r.row_hash, v_id
      from public.sheet_mirror_staging s
     cross join lateral jsonb_populate_record(null::public.sheet_encounter_lines, s.row) r
     where s.run_id = v_id and s.tab = p_tab
     order by s.seq;
  else
    raise exception 'Unknown mirror tab.' using errcode = '22023';
  end if;
  get diagnostics v_n = row_count;
  if v_n is distinct from p_expected then
    raise exception 'Staged row count mismatch: staged %, expected %.', v_n, p_expected using errcode = '22023';
  end if;
  delete from public.sheet_mirror_staging where run_id = v_id and tab = p_tab;
  return v_n;
end $$;

-- Applies one chunk of the planner's customer ops. Contract (types.ts CustomerOp):
--   create — new sheet-owned patient; each link key is written 'admin' when it
--            is in admin_link_keys (a subset of link_keys) and 'auto_exact'
--            otherwise; never over an admin row unless that row is an admin
--            "create" decision.
--   link   — auto link, never over an admin row.
--   fill   — fill-only-if-empty (+ the channel when unset or sheet-owned).
--   facts  — acquisition facts upsert.
--   hold   — persist a review: (link_key, no patient, 'review'), never over an
--            admin row.
-- create / link / hold stamp sheet_patient_links.run_id with this run.
create or replace function public.sheet_sync_apply_customer_ops(p_lease_token uuid, p_ops jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run uuid := public._sheet_sync_fence(p_lease_token, true);
  v_actor uuid;
  v_import uuid;
  v_op jsonb;
  v_f jsonb;
  v_admin_keys jsonb;
  v_old public.patients%rowtype;
  v_new public.patients%rowtype;
  v_pid uuid;
  v_key text;
  v_src text;
  v_hit boolean;
  v_rows int;
  v_created jsonb := '{}'::jsonb;
  n_created int := 0; n_linked int := 0; n_filled int := 0; n_facts int := 0; n_held int := 0; n_skipped int := 0;
begin
  if jsonb_typeof(p_ops) is distinct from 'array' then
    raise exception 'Bad ops batch.' using errcode = '22023';
  end if;
  select r.actor_id, r.legacy_import_run_id into v_actor, v_import from public.sheet_sync_runs r where r.id = v_run;

  for v_op in select e from jsonb_array_elements(p_ops) e loop
    if v_op->>'op' = 'create' then
      v_admin_keys := coalesce(v_op->'admin_link_keys', '[]'::jsonb);
      if jsonb_typeof(v_op->'link_keys') is distinct from 'array'
         or jsonb_typeof(v_admin_keys) is distinct from 'array'
         or exists (select 1 from jsonb_array_elements_text(v_admin_keys) k where not ((v_op->'link_keys') ? k)) then
        raise exception 'Bad create op: admin_link_keys must be a subset of link_keys.' using errcode = '22023';
      end if;
      if v_import is null then
        insert into public.legacy_import_runs (source, dry_run, run_by, notes)
        values ('sheet_sync:CUSTOMER LIST2', false, v_actor, 'sheet_sync_runs ' || v_run)
        returning id into v_import;
        update public.sheet_sync_runs set legacy_import_run_id = v_import where id = v_run;
      end if;
      v_f := v_op->'fields';
      v_src := (select rs.id from public.referral_sources rs where rs.id = nullif(v_f->>'referral_source', ''));
      perform set_config('app.referral_origin', 'sheet', true);
      insert into public.patients (first_name, last_name, middle_name, birthdate, sex, phone, email, address,
        referral_source, referred_by_doctor, preferred_release_medium, senior_pwd_id_kind, senior_pwd_id_number,
        legacy_intake, legacy_import_run_id, birthdate_confirmed)
      values (v_f->>'first_name', v_f->>'last_name', nullif(v_f->>'middle_name', ''),
        nullif(v_f->>'birthdate', '')::date, nullif(v_f->>'sex', ''), nullif(v_f->>'phone', ''),
        nullif(v_f->>'email', ''), nullif(v_f->>'address', ''), v_src, nullif(v_f->>'referred_by_doctor', ''),
        nullif(v_f->>'preferred_release_medium', ''),
        -- the Senior/PWD pair is written together or not at all
        case when nullif(v_f->>'senior_pwd_id_kind', '') is not null and nullif(v_f->>'senior_pwd_id_number', '') is not null
             then v_f->>'senior_pwd_id_kind' end,
        case when nullif(v_f->>'senior_pwd_id_kind', '') is not null and nullif(v_f->>'senior_pwd_id_number', '') is not null
             then v_f->>'senior_pwd_id_number' end,
        v_op->'legacy_intake', v_import, false)
      returning id into v_pid;
      perform set_config('app.referral_origin', '', true);
      insert into public.sheet_sync_changes (run_id, patient_id, change_kind, row_version_after)
      values (v_run, v_pid, 'create', 0);
      for v_key in select jsonb_array_elements_text(v_op->'link_keys') loop
        insert into public.sheet_patient_links (link_key, patient_id, decision, method, run_id)
        values (v_key, v_pid, 'link', case when v_admin_keys ? v_key then 'admin' else 'auto_exact' end, v_run)
        on conflict (link_key) do update
          set patient_id = excluded.patient_id, decision = 'link', method = excluded.method,
              run_id = excluded.run_id, decided_at = now()
          where public.sheet_patient_links.method <> 'admin' or public.sheet_patient_links.decision = 'create';
      end loop;
      insert into public.patient_acquisition_facts (patient_id, registered_on, sheet_new_repeat, source_ref)
      values (v_pid, nullif(v_op->'facts'->>'registered_on', '')::date,
              nullif(v_op->'facts'->>'new_repeat', ''), v_op->'facts'->>'source_ref');
      v_created := v_created || jsonb_build_object(v_op->>'create_key', v_pid);
      n_created := n_created + 1;

    elsif v_op->>'op' = 'link' then
      insert into public.sheet_patient_links (link_key, patient_id, decision, method, run_id)
      values (v_op->>'link_key', (v_op->>'patient_id')::uuid, 'link', v_op->>'method', v_run)
      on conflict (link_key) do update
        set patient_id = excluded.patient_id, method = excluded.method, decision = 'link',
            run_id = excluded.run_id, decided_at = now()
        where public.sheet_patient_links.method <> 'admin';
      n_linked := n_linked + 1;

    elsif v_op->>'op' = 'hold' then
      if coalesce(v_op->>'link_key', '') = '' then
        raise exception 'Bad hold op.' using errcode = '22023';
      end if;
      insert into public.sheet_patient_links (link_key, patient_id, decision, method, run_id)
      values (v_op->>'link_key', null, 'review', 'auto_exact', v_run)
      on conflict (link_key) do update
        set decision = 'review', patient_id = null, run_id = excluded.run_id, decided_at = now()
        where public.sheet_patient_links.method <> 'admin';
      get diagnostics v_rows = row_count;
      if v_rows > 0 then n_held := n_held + 1; else n_skipped := n_skipped + 1; end if;

    elsif v_op->>'op' = 'fill' then
      v_f := v_op->'fields';
      select * into v_old from public.patients p
       where p.id = (v_op->>'patient_id')::uuid and p.merged_into_id is null
       for update;
      if not found then n_skipped := n_skipped + 1; continue; end if;
      v_src := case
        when not (v_f ? 'referral_source') then v_old.referral_source
        when v_old.referral_source is null or v_old.referral_source_origin = 'sheet'
          then (select rs.id from public.referral_sources rs where rs.id = nullif(v_f->>'referral_source', ''))
        else v_old.referral_source end;
      perform set_config('app.referral_origin', 'sheet', true);
      update public.patients p set
        phone = coalesce(p.phone, nullif(v_f->>'phone', '')),
        email = coalesce(p.email, nullif(v_f->>'email', '')),
        birthdate = coalesce(p.birthdate, nullif(v_f->>'birthdate', '')::date),
        sex = coalesce(p.sex, nullif(v_f->>'sex', '')),
        address = coalesce(p.address, nullif(v_f->>'address', '')),
        referred_by_doctor = coalesce(p.referred_by_doctor, nullif(v_f->>'referred_by_doctor', '')),
        preferred_release_medium = coalesce(p.preferred_release_medium, nullif(v_f->>'preferred_release_medium', '')),
        -- the Senior/PWD pair: filled together, only when both are empty on
        -- the patient and both are present in the op
        senior_pwd_id_kind = case when p.senior_pwd_id_kind is null and p.senior_pwd_id_number is null
                                       and nullif(v_f->>'senior_pwd_id_kind', '') is not null
                                       and nullif(v_f->>'senior_pwd_id_number', '') is not null
                                  then v_f->>'senior_pwd_id_kind' else p.senior_pwd_id_kind end,
        senior_pwd_id_number = case when p.senior_pwd_id_kind is null and p.senior_pwd_id_number is null
                                         and nullif(v_f->>'senior_pwd_id_kind', '') is not null
                                         and nullif(v_f->>'senior_pwd_id_number', '') is not null
                                    then v_f->>'senior_pwd_id_number' else p.senior_pwd_id_number end,
        referral_source = v_src
      where p.id = v_old.id
        and ( (p.phone is null and nullif(v_f->>'phone', '') is not null)
           or (p.email is null and nullif(v_f->>'email', '') is not null)
           or (p.birthdate is null and nullif(v_f->>'birthdate', '') is not null)
           or (p.sex is null and nullif(v_f->>'sex', '') is not null)
           or (p.address is null and nullif(v_f->>'address', '') is not null)
           or (p.referred_by_doctor is null and nullif(v_f->>'referred_by_doctor', '') is not null)
           or (p.preferred_release_medium is null and nullif(v_f->>'preferred_release_medium', '') is not null)
           or (p.senior_pwd_id_kind is null and p.senior_pwd_id_number is null
               and nullif(v_f->>'senior_pwd_id_kind', '') is not null
               and nullif(v_f->>'senior_pwd_id_number', '') is not null)
           or (p.referral_source is distinct from v_src) )
      returning * into v_new;
      -- Capture FOUND before the PERFORM below: PERFORM resets it (to true,
      -- since set_config returns a row), which made a no-op fill look like
      -- a hit and record a before-image with a NULL patient id.
      v_hit := found;
      perform set_config('app.referral_origin', '', true);
      if v_hit then
        perform public._sheet_sync_record_changes(v_run, to_jsonb(v_old), to_jsonb(v_new));
        n_filled := n_filled + 1;
      else
        n_skipped := n_skipped + 1;
      end if;

    elsif v_op->>'op' = 'facts' then
      insert into public.patient_acquisition_facts (patient_id, registered_on, sheet_new_repeat, source_ref)
      values ((v_op->>'patient_id')::uuid, nullif(v_op->>'registered_on', '')::date,
              nullif(v_op->>'new_repeat', ''), v_op->>'source_ref')
      on conflict (patient_id) do update
        set registered_on = excluded.registered_on, sheet_new_repeat = excluded.sheet_new_repeat,
            source_ref = excluded.source_ref, updated_at = now();
      n_facts := n_facts + 1;

    else
      raise exception 'Unknown customer op.' using errcode = '22023';
    end if;
  end loop;

  return jsonb_build_object('created', v_created, 'counts', jsonb_build_object(
    'created', n_created, 'linked', n_linked, 'filled', n_filled, 'facts', n_facts,
    'held', n_held, 'skipped', n_skipped));
end $$;

create or replace function public.sheet_sync_upsert_review(
  p_lease_token uuid, p_tab text, p_items jsonb, p_clear_absent boolean
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run uuid := public._sheet_sync_fence(p_lease_token, true);
  v_item jsonb;
  n_opened int := 0; n_updated int := 0; n_cleared int := 0;
begin
  if p_tab not in ('customers','lab','consult') or jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'Bad review batch.' using errcode = '22023';
  end if;
  for v_item in select e from jsonb_array_elements(p_items) e loop
    if exists (select 1 from public.sheet_sync_review_items i
                where i.kind = v_item->>'kind' and i.item_key = v_item->>'item_key' and i.status = 'dismissed') then
      continue;
    end if;
    update public.sheet_sync_review_items i
       set payload = coalesce(v_item->'payload', '{}'::jsonb), run_id = v_run, last_seen_at = now()
     where i.kind = v_item->>'kind' and i.item_key = v_item->>'item_key' and i.status = 'open';
    if found then
      n_updated := n_updated + 1;
    else
      insert into public.sheet_sync_review_items (run_id, tab, item_key, kind, payload)
      values (v_run, p_tab, v_item->>'item_key', v_item->>'kind', coalesce(v_item->'payload', '{}'::jsonb));
      n_opened := n_opened + 1;
    end if;
  end loop;
  if p_clear_absent then
    update public.sheet_sync_review_items i
       set status = 'resolved', resolution = jsonb_build_object('auto', 'no longer reported by the sheet'), resolved_at = now()
     where i.tab = p_tab and i.status = 'open'
       and not exists (select 1 from jsonb_array_elements(p_items) e
                        where e->>'kind' = i.kind and e->>'item_key' = i.item_key);
    get diagnostics n_cleared = row_count;
  end if;
  return jsonb_build_object('opened', n_opened, 'updated', n_updated, 'cleared', n_cleared);
end $$;

-- Re-sort only ever moves patients the May import created (the same set
-- sheet_resort_candidates lists); a stray id is skipped, never re-sorted.
create or replace function public.sheet_resort_apply(
  p_lease_token uuid, p_patient_ids uuid[], p_expected_old text, p_new text
) returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_run uuid := public._sheet_sync_fence(p_lease_token, true);
  v_old public.patients%rowtype;
  v_new public.patients%rowtype;
  v_id uuid;
  v_n int := 0;
begin
  if p_new is not null and not exists (select 1 from public.referral_sources rs where rs.id = p_new) then
    raise exception 'Unknown channel.' using errcode = '22023';
  end if;
  if p_new is not distinct from p_expected_old then return 0; end if;
  foreach v_id in array coalesce(p_patient_ids, '{}'::uuid[]) loop
    select * into v_old from public.patients p
     where p.id = v_id and p.merged_into_id is null
       and p.legacy_intake->>'source' = 'google_sheet_CUSTOMER_LIST2'
       and p.referral_source is not distinct from p_expected_old
       and p.referral_source_origin is distinct from 'patient'
     for update;
    if not found then continue; end if;
    perform set_config('app.referral_origin', 'sheet', true);
    update public.patients set referral_source = p_new where id = v_id returning * into v_new;
    perform set_config('app.referral_origin', '', true);
    perform public._sheet_sync_record_changes(v_run, to_jsonb(v_old), to_jsonb(v_new));
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

create or replace function public.sheet_alias_apply(
  p_lease_token uuid, p_raw_normalized text, p_source_id text, p_actor uuid
) returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_run uuid := public._sheet_sync_fence(p_lease_token, true);
  v_old public.patients%rowtype;
  v_new public.patients%rowtype;
  v_id uuid;
  v_n int := 0;
begin
  if coalesce(p_raw_normalized, '') = '' or not exists (select 1 from public.referral_sources rs where rs.id = p_source_id) then
    raise exception 'Unknown channel.' using errcode = '22023';
  end if;
  insert into public.referral_source_aliases (raw_normalized, referral_source_id, created_by)
  values (p_raw_normalized, p_source_id, p_actor)
  on conflict (raw_normalized) do update
    set referral_source_id = excluded.referral_source_id, created_by = excluded.created_by, created_at = now();
  update public.sheet_customer_rows set referral_source_id = p_source_id where source_norm = p_raw_normalized;
  for v_id in select distinct c.patient_id from public.sheet_customer_rows c
               where c.source_norm = p_raw_normalized and c.patient_id is not null loop
    select * into v_old from public.patients p
     where p.id = v_id and p.merged_into_id is null
       and (p.referral_source is null or p.referral_source_origin = 'sheet')
     for update;
    if not found or v_old.referral_source is not distinct from p_source_id then continue; end if;
    perform set_config('app.referral_origin', 'sheet', true);
    update public.patients set referral_source = p_source_id where id = v_id returning * into v_new;
    perform set_config('app.referral_origin', '', true);
    perform public._sheet_sync_record_changes(v_run, to_jsonb(v_old), to_jsonb(v_new));
    v_n := v_n + 1;
  end loop;
  update public.sheet_sync_review_items
     set status = 'resolved', resolved_by = p_actor, resolved_at = now(),
         resolution = jsonb_build_object('action', 'alias', 'referral_source_id', p_source_id)
   where kind = 'unmapped_source' and item_key = p_raw_normalized and status = 'open';
  return v_n;
end $$;

-- Undo one run. Patient columns go back to their pre-run values unless the
-- patient changed since (row_version). The run's auto identity decisions and
-- every link of a patient the undo deletes become HOLDS (decision 'review'),
-- so the next nightly run sends those rows to review instead of re-deriving
-- the link the admin just undid.
create or replace function public.sheet_sync_revert_run(p_lease_token uuid, p_target_run uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run uuid := public._sheet_sync_fence(p_lease_token, true);
  v_pid uuid;
  v_ver bigint;
  v_map jsonb;
  v_cur public.patients%rowtype;
  v_new public.patients%rowtype;
  v_rows int;
  n_restored int := 0; n_blocked int := 0; n_deleted int := 0; n_kept int := 0; n_held int := 0;
begin
  if exists (select 1 from public.sheet_sync_runs r where r.id = p_target_run and r.reverted_by_run_id is not null) then
    raise exception 'This run has already been undone.' using errcode = '22023';
  end if;

  for v_pid, v_ver, v_map in
    -- order by id desc: when one run changed a column twice, the EARLIEST
    -- before-image (the true pre-run value) is aggregated last and wins.
    select c.patient_id, max(c.row_version_after), jsonb_object_agg(c.column_name, c.old_value order by c.id desc)
      from public.sheet_sync_changes c
     where c.run_id = p_target_run and c.change_kind = 'update' and c.reverted_at is null
     group by c.patient_id
  loop
    select * into v_cur from public.patients p where p.id = v_pid for update;
    if not found or v_cur.row_version <> v_ver then n_blocked := n_blocked + 1; continue; end if;
    -- The origin is only recorded when it changed. When it did not (a
    -- sheet -> sheet channel move), row_version equality proves the current
    -- origin is still the pre-run one, so restore under that.
    perform set_config('app.referral_origin',
      coalesce(v_map->>'referral_source_origin', v_cur.referral_source_origin, 'staff'), true);
    update public.patients p set
      phone = case when v_map ? 'phone' then v_map->>'phone' else p.phone end,
      email = case when v_map ? 'email' then v_map->>'email' else p.email end,
      birthdate = case when v_map ? 'birthdate' then (v_map->>'birthdate')::date else p.birthdate end,
      sex = case when v_map ? 'sex' then v_map->>'sex' else p.sex end,
      address = case when v_map ? 'address' then v_map->>'address' else p.address end,
      referred_by_doctor = case when v_map ? 'referred_by_doctor' then v_map->>'referred_by_doctor' else p.referred_by_doctor end,
      preferred_release_medium = case when v_map ? 'preferred_release_medium' then v_map->>'preferred_release_medium' else p.preferred_release_medium end,
      senior_pwd_id_kind = case when v_map ? 'senior_pwd_id_kind' then v_map->>'senior_pwd_id_kind' else p.senior_pwd_id_kind end,
      senior_pwd_id_number = case when v_map ? 'senior_pwd_id_number' then v_map->>'senior_pwd_id_number' else p.senior_pwd_id_number end,
      referral_source = case when v_map ? 'referral_source' then v_map->>'referral_source' else p.referral_source end
    where p.id = v_pid
    returning * into v_new;
    perform set_config('app.referral_origin', '', true);
    perform public._sheet_sync_record_changes(v_run, to_jsonb(v_cur), to_jsonb(v_new));
    update public.sheet_sync_changes set reverted_at = now()
     where run_id = p_target_run and patient_id = v_pid and change_kind = 'update';
    n_restored := n_restored + 1;
  end loop;

  -- The run's own auto decisions (still the latest word on their key) -> holds.
  update public.sheet_patient_links l
     set decision = 'review', patient_id = null, run_id = v_run, decided_at = now()
   where l.run_id = p_target_run and l.method <> 'admin' and l.decision <> 'review';
  get diagnostics v_rows = row_count;
  n_held := n_held + v_rows;

  for v_pid in select c.patient_id from public.sheet_sync_changes c
                where c.run_id = p_target_run and c.change_kind = 'create' and c.reverted_at is null loop
    select p.row_version into v_ver from public.patients p where p.id = v_pid for update;
    if not found then continue; end if;
    if v_ver <> 0 then n_kept := n_kept + 1; continue; end if;
    begin
      -- Hold (not cascade-delete) every key that pointed at this patient.
      update public.sheet_patient_links
         set decision = 'review', patient_id = null, run_id = v_run, decided_at = now()
       where patient_id = v_pid;
      get diagnostics v_rows = row_count;
      delete from public.patient_acquisition_facts where patient_id = v_pid;
      update public.sheet_customer_rows set patient_id = null, link_state = 'unlinked' where patient_id = v_pid;
      update public.sheet_encounter_lines set patient_id = null where patient_id = v_pid;
      delete from public.patients where id = v_pid;
      update public.sheet_sync_changes set reverted_at = now()
       where run_id = p_target_run and patient_id = v_pid and change_kind = 'create';
      n_deleted := n_deleted + 1;
      n_held := n_held + v_rows;
    exception when foreign_key_violation then
      n_kept := n_kept + 1;
    end;
  end loop;

  update public.sheet_sync_runs set reverted_by_run_id = v_run where id = p_target_run;
  return jsonb_build_object('restored', n_restored, 'blocked', n_blocked, 'deleted', n_deleted,
                            'kept', n_kept, 'held', n_held);
end $$;

-- Re-sort candidates: May-imported live patients and their original answer
-- (the key holds spaces and a "?", which a PostgREST select path cannot address).
create or replace function public.sheet_resort_candidates()
returns table (id uuid, answer text, referral_source text, referral_source_origin text)
language sql stable security definer set search_path = '' as $$
  select p.id, coalesce(p.legacy_intake->'raw'->>'How did you know about DR Med?', ''),
         p.referral_source, p.referral_source_origin
    from public.patients p
   where p.merged_into_id is null
     and p.legacy_intake->>'source' = 'google_sheet_CUSTOMER_LIST2'
   order by p.id;
$$;

-- Admin decision on a review item. Refused while a real (non-preview) sync
-- is mid-run with a live heartbeat, so a decision cannot land between that
-- run's read of the saved decisions and its writes. A run with no heartbeat
-- for 10 minutes is dead by the lease's own rule and does not block.
create or replace function public.sheet_review_resolve(
  p_item_id uuid, p_actor uuid, p_action text, p_patient_id uuid
) returns void language plpgsql security definer set search_path = '' as $$
declare v_item public.sheet_sync_review_items%rowtype;
begin
  if exists (select 1 from public.sheet_sync_runs r
              where r.status = 'running' and not r.dry_run
                and r.heartbeat_at > now() - interval '10 minutes') then
    raise exception 'Another sheet sync is running.' using errcode = 'P0062';
  end if;
  select * into v_item from public.sheet_sync_review_items i where i.id = p_item_id and i.status = 'open' for update;
  if not found then
    raise exception 'This review item was already handled.' using errcode = 'P0064';
  end if;
  if p_action = 'dismiss' then
    update public.sheet_sync_review_items
       set status = 'dismissed', resolved_by = p_actor, resolved_at = now(), resolution = jsonb_build_object('action', 'dismiss')
     where id = p_item_id;
    return;
  end if;
  if p_action not in ('link','create')
     or v_item.kind not in ('ambiguous_patient','identity_conflict','possible_existing_patient') then
    raise exception 'That action does not fit this item.' using errcode = '22023';
  end if;
  if p_action = 'link' and not exists (select 1 from public.patients p where p.id = p_patient_id and p.merged_into_id is null) then
    raise exception 'Pick a current (not merged) patient.' using errcode = '22023';
  end if;
  -- Overwrites any saved decision for the key, holds included.
  insert into public.sheet_patient_links (link_key, patient_id, decision, method, decided_by, run_id)
  select k, case when p_action = 'link' then p_patient_id end, p_action, 'admin', p_actor, null
    from jsonb_array_elements_text(coalesce(v_item.payload->'link_keys', '[]'::jsonb)) k
  on conflict (link_key) do update
    set patient_id = excluded.patient_id, decision = excluded.decision, method = 'admin',
        decided_by = excluded.decided_by, decided_at = now(), run_id = null;
  update public.sheet_sync_review_items
     set status = 'resolved', resolved_by = p_actor, resolved_at = now(),
         resolution = jsonb_build_object('action', p_action, 'patient_id', p_patient_id)
   where id = p_item_id;
end $$;

-- ACLs: born closed since 0119, restated by name (hosted Supabase keeps direct
-- anon/authenticated grants that `from public` alone does not remove).
do $$
declare f text;
begin
  foreach f in array array[
    'public._sheet_sync_fence(uuid, boolean)',
    'public._sheet_sync_record_changes(uuid, jsonb, jsonb)',
    'public.sheet_sync_acquire(text, uuid, boolean)',
    'public.sheet_sync_heartbeat(uuid)',
    'public.sheet_sync_finish(uuid, text, jsonb, jsonb, text)',
    'public.sheet_mirror_stage(uuid, text, jsonb)',
    'public.sheet_mirror_commit(uuid, text, integer)',
    'public.sheet_sync_apply_customer_ops(uuid, jsonb)',
    'public.sheet_sync_upsert_review(uuid, text, jsonb, boolean)',
    'public.sheet_resort_apply(uuid, uuid[], text, text)',
    'public.sheet_alias_apply(uuid, text, text, uuid)',
    'public.sheet_sync_revert_run(uuid, uuid)',
    'public.sheet_review_resolve(uuid, uuid, text, uuid)',
    'public.sheet_resort_candidates()'] loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke execute on function %s from anon, authenticated', f);
  end loop;
end $$;
revoke execute on function public._sheet_sync_fence(uuid, boolean) from service_role;
revoke execute on function public._sheet_sync_record_changes(uuid, jsonb, jsonb) from service_role;
grant execute on function public.sheet_sync_acquire(text, uuid, boolean) to service_role;
grant execute on function public.sheet_sync_heartbeat(uuid) to service_role;
grant execute on function public.sheet_sync_finish(uuid, text, jsonb, jsonb, text) to service_role;
grant execute on function public.sheet_mirror_stage(uuid, text, jsonb) to service_role;
grant execute on function public.sheet_mirror_commit(uuid, text, integer) to service_role;
grant execute on function public.sheet_sync_apply_customer_ops(uuid, jsonb) to service_role;
grant execute on function public.sheet_sync_upsert_review(uuid, text, jsonb, boolean) to service_role;
grant execute on function public.sheet_resort_apply(uuid, uuid[], text, text) to service_role;
grant execute on function public.sheet_alias_apply(uuid, text, text, uuid) to service_role;
grant execute on function public.sheet_sync_revert_run(uuid, uuid) to service_role;
grant execute on function public.sheet_review_resolve(uuid, uuid, text, uuid) to service_role;
grant execute on function public.sheet_resort_candidates() to service_role;

-- 6. Post-conditions (abort the deploy, never a user) ------------------------
do $$
declare
  v_fn regprocedure;
  v_t text;
begin
  if (select count(*) from public.referral_sources) <> 18 then
    raise exception '0170: expected 18 referral sources';
  end if;
  if exists (select 1 from public.patients
              where referral_source is not null and referral_source_origin is distinct from 'staff'
                and not (referral_source_origin = 'patient' and pre_registered
                         and created_at >= timestamptz '2026-09-24 00:00+08')) then
    raise exception '0170: an existing referral_source got an owner other than staff (or a post-0158 patient answer)';
  end if;
  if not (select paused from public.sheet_sync_settings where id) then
    raise exception '0170: sheet sync must ship paused';
  end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
                and c.relname in ('sheet_sync_settings','sheet_sync_runs','sheet_sync_review_items','sheet_sync_changes',
                  'sheet_patient_links','patient_acquisition_facts','referral_source_aliases','sheet_customer_rows',
                  'sheet_encounter_lines','sheet_mirror_staging')) then
    raise exception '0170: RLS missing on a sheet sync table';
  end if;

  -- Every sheet sync routine (and the two re-created patient routines) is
  -- closed to both JWT roles — including any overload added later.
  for v_fn in
    select p.oid::regprocedure
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and (p.proname like 'sheet\_%' or p.proname like '\_sheet\_sync\_%'
            or p.proname in ('resolve_patient_guarded', 'patients_referral_origin_guard'))
  loop
    if has_function_privilege('anon', v_fn, 'execute') or has_function_privilege('authenticated', v_fn, 'execute') then
      raise exception '0170: % must not be executable by anon/authenticated', v_fn;
    end if;
  end loop;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and (p.proname like 'sheet\_%' or p.proname like '\_sheet\_sync\_%')) <> 14 then
    raise exception '0170: expected exactly 14 sheet sync routines (a stale overload survived?)';
  end if;

  -- Tables: anon gets nothing; authenticated may only read, and never the staging table.
  foreach v_t in array array['sheet_sync_settings','sheet_sync_runs','sheet_sync_review_items','sheet_sync_changes',
      'sheet_patient_links','patient_acquisition_facts','referral_source_aliases','sheet_customer_rows',
      'sheet_encounter_lines','sheet_mirror_staging'] loop
    if has_table_privilege('anon', 'public.' || v_t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
      raise exception '0170: anon holds a privilege on %', v_t;
    end if;
    if has_table_privilege('authenticated', 'public.' || v_t, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
      raise exception '0170: authenticated holds a write privilege on %', v_t;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.sheet_mirror_staging', 'SELECT') then
    raise exception '0170: authenticated can read sheet_mirror_staging';
  end if;

  -- The backfill's disable/enable window closed, and the ownership trigger is live.
  if not exists (select 1 from pg_trigger where tgrelid = 'public.patients'::regclass
                  and tgname = 'trg_patients_updated_at' and tgenabled = 'O') then
    raise exception '0170: trg_patients_updated_at is not enabled';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.patients'::regclass
                  and tgname = 'trg_patients_referral_origin' and tgenabled = 'O') then
    raise exception '0170: trg_patients_referral_origin is missing or disabled';
  end if;
end $$;
