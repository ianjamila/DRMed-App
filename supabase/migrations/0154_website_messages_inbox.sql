-- =============================================================================
-- 0154 — Website Messages inbox, appointment source, retire Inquiries
-- =============================================================================
-- Three changes that ship together (spec:
-- docs/superpowers/specs/2026-09-24-website-messages-inbox.md):
--
-- 1. RETIRE `inquiries` (0012). Reception's manual inquiry log was never used:
--    zero rows on prod from go-live to 2026-09-24. Its job (a person who has
--    not booked yet, to call back) is covered by the appointments'
--    `pending_callback` status and by the new inbox below. The drop refuses to
--    run if the table has gained rows since.
--
-- 2. `contact_messages` (0004) becomes a real inbox. The public /contact form
--    has written here since launch, but no staff screen ever read it — 17
--    messages, none handled, by 2026-09-24. Adds a workflow status (replacing
--    the never-used `handled` boolean), a corporate-lead kind, staff notes, a
--    link to the appointment booked from the message, and the sender's
--    first-party ad attribution (UTM cookie). `handled_by` / `handled_at` are
--    kept and now mean "who last changed the status, and when".
--
--    Also closes a hole: 0004 gave anon a `with check (true)` INSERT policy,
--    so anyone holding the public anon key could write rows straight through
--    PostgREST, skipping the server action's honeypot and rate limit. The
--    form inserts with the service-role client, so anon needs no access at
--    all. Staff get SELECT + UPDATE (reception/admin); nobody gets DELETE
--    through a JWT — "Closed" is how a message is dismissed.
--
--    What the sender wrote is immutable (P0053): staff can change the status,
--    kind, notes and booking link, never the name, contact details, subject,
--    message, attribution or request metadata.
--
-- 3. `appointments.source` — how the patient reached the clinic — and
--    `appointments.attribution` (the UTM cookie at booking time). Until now
--    attribution lived only in audit_log metadata, so no screen could report
--    it. `appointments_insert_slot_guarded` (0112) inserts with an explicit
--    column list, so it is re-created to carry both. Its ACL is restated as
--    0113 left it: service_role only.
--
--    Backfill: rows whose booking group has an `appointment.booked` audit row
--    take `via` (schedule → online_booking, portal → patient_portal) and that
--    row's attribution; any other row with no `created_by` came through the
--    public form too (only staff actions stamp created_by). Staff-created
--    rows stay NULL = "Not recorded".
--
-- The CHECK lists below are pinned to src/lib/appointments/source.ts and
-- src/lib/contact-messages/labels.ts by website-messages-schema.test.ts.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Retire inquiries
-- ---------------------------------------------------------------------------
do $$
declare
  v_rows bigint;
begin
  if to_regclass('public.inquiries') is not null then
    execute 'select count(*) from public.inquiries' into v_rows;
    if v_rows > 0 then
      raise exception '0154: refusing to drop public.inquiries — it holds % row(s). Export them first.', v_rows;
    end if;
  end if;
end;
$$;

drop table if exists public.inquiries;

-- ---------------------------------------------------------------------------
-- 2. contact_messages → Website Messages inbox
-- ---------------------------------------------------------------------------
alter table public.contact_messages
  add column if not exists status text not null default 'new',
  add column if not exists kind text not null default 'general',
  add column if not exists staff_notes text,
  add column if not exists linked_appointment_id uuid
    references public.appointments(id) on delete set null,
  add column if not exists attribution jsonb,
  add column if not exists updated_at timestamptz not null default now();

-- `handled` was never set by anything (no staff screen existed). Carry it
-- over anyway so the replay is lossless.
update public.contact_messages
   set status = case when handled then 'closed' else 'new' end
 where status = 'new';

-- Must match CORPORATE_SUBJECT in src/lib/contact-messages/labels.ts.
update public.contact_messages
   set kind = 'corporate'
 where subject = 'Corporate / HMO';

alter table public.contact_messages
  add constraint contact_messages_status_check
    check (status in ('new', 'replied', 'booked', 'closed')),
  add constraint contact_messages_kind_check
    check (kind in ('general', 'corporate')),
  add constraint contact_messages_staff_notes_len
    check (staff_notes is null or char_length(staff_notes) <= 2000),
  add constraint contact_messages_attribution_object
    check (attribution is null or jsonb_typeof(attribution) = 'object');

drop index if exists public.idx_contact_messages_handled;
alter table public.contact_messages drop column if exists handled;

-- The inbox pages by status then newest first (id = the unique tie-break);
-- the nav badge and dashboard count read the partial index.
create index if not exists idx_contact_messages_status_created
  on public.contact_messages (status, created_at desc, id);
create index if not exists idx_contact_messages_new
  on public.contact_messages (created_at desc)
  where status = 'new';
create index if not exists idx_contact_messages_linked_appointment
  on public.contact_messages (linked_appointment_id)
  where linked_appointment_id is not null;

drop trigger if exists trg_contact_messages_updated_at on public.contact_messages;
create trigger trg_contact_messages_updated_at
  before update on public.contact_messages
  for each row execute function public.touch_updated_at();

create or replace function public.contact_messages_guard_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.id is distinct from old.id
     or new.name is distinct from old.name
     or new.email is distinct from old.email
     or new.phone is distinct from old.phone
     or new.subject is distinct from old.subject
     or new.message is distinct from old.message
     or new.ip_address is distinct from old.ip_address
     or new.user_agent is distinct from old.user_agent
     or new.attribution is distinct from old.attribution
     or new.created_at is distinct from old.created_at then
    raise exception 'A website message cannot be edited — only its status, type, notes and booking link can change.'
      using errcode = 'P0053';
  end if;
  return new;
end;
$$;

-- Trigger functions need no EXECUTE grant (checked at create trigger time).
revoke all on function public.contact_messages_guard_immutable() from public, anon, authenticated;

drop trigger if exists trg_contact_messages_guard_immutable on public.contact_messages;
create trigger trg_contact_messages_guard_immutable
  before update on public.contact_messages
  for each row execute function public.contact_messages_guard_immutable();

-- RLS: server-side inserts only; reception/admin read and triage.
drop policy if exists "contact_messages: public insert" on public.contact_messages;
drop policy if exists "contact_messages: reception/admin manage" on public.contact_messages;

revoke all on public.contact_messages from anon;
revoke all on public.contact_messages from authenticated;
grant select, update on public.contact_messages to authenticated;

create policy "contact_messages: reception/admin read"
  on public.contact_messages
  for select
  to authenticated
  using ((select public.has_role(array['reception', 'admin'])));

create policy "contact_messages: reception/admin update"
  on public.contact_messages
  for update
  to authenticated
  using ((select public.has_role(array['reception', 'admin'])))
  with check ((select public.has_role(array['reception', 'admin'])));

-- ---------------------------------------------------------------------------
-- 3. appointments.source + attribution
-- ---------------------------------------------------------------------------
alter table public.appointments
  add column if not exists source text,
  add column if not exists attribution jsonb;

alter table public.appointments
  add constraint appointments_source_check
    check (source is null or source in (
      'online_booking', 'patient_portal', 'website_message', 'phone', 'sms',
      'messenger', 'walk_in', 'referral', 'other'
    )),
  add constraint appointments_attribution_object
    check (attribution is null or jsonb_typeof(attribution) = 'object');

with booked as (
  select distinct on (a.resource_id)
         a.resource_id as group_id,
         a.metadata ->> 'via' as via,
         a.metadata -> 'attribution' as attribution
    from public.audit_log a
   where a.action = 'appointment.booked'
     and a.resource_type = 'appointment_group'
     and a.resource_id is not null
   order by a.resource_id, a.created_at
)
update public.appointments ap
   set source = case b.via when 'portal' then 'patient_portal' else 'online_booking' end,
       attribution = case when jsonb_typeof(b.attribution) = 'object' then b.attribution end
  from booked b
 where ap.booking_group_id = b.group_id
   and ap.source is null;

update public.appointments
   set source = 'online_booking'
 where source is null
   and created_by is null;

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

-- ---------------------------------------------------------------------------
-- Post-conditions
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.inquiries') is not null then
    raise exception '0154 post-check: public.inquiries still exists';
  end if;
  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'contact_messages'
       and ('anon' = any(roles) or 'public' = any(roles))
  ) then
    raise exception '0154 post-check: contact_messages still has an anon/public policy';
  end if;
  if (select count(*) from pg_policies
       where schemaname = 'public' and tablename = 'contact_messages') <> 2 then
    raise exception '0154 post-check: contact_messages should have exactly 2 policies';
  end if;
  if has_table_privilege('anon', 'public.contact_messages', 'insert')
     or has_table_privilege('anon', 'public.contact_messages', 'select') then
    raise exception '0154 post-check: anon can still reach contact_messages';
  end if;
  if has_function_privilege('anon', 'public.appointments_insert_slot_guarded(jsonb, uuid, timestamptz, boolean)', 'execute')
     or has_function_privilege('authenticated', 'public.appointments_insert_slot_guarded(jsonb, uuid, timestamptz, boolean)', 'execute') then
    raise exception '0154 post-check: appointments_insert_slot_guarded is callable by a JWT role';
  end if;
end;
$$;
