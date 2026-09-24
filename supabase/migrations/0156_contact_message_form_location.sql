-- 0156: record WHICH copy of the public contact form sent a website message.
--
-- The same form is on two pages of drmed.ph: the Contact page (/contact, also
-- where the "Custom Corporate Package" / "Get a Corporate Quote" buttons land)
-- and the "Send us a message" section at the bottom of the home page. Staff
-- asked where each message came from and nothing recorded it.
--
-- `form_location` is set by the server action from a hidden field, checked
-- against the same allow-list as below, so a visitor tampering with the field
-- stores NULL rather than free text. The 17 messages received before this
-- migration stay NULL — the inbox and Booking Sources show "Not recorded" —
-- because nothing reliable says which page they came from.
--
-- It is part of what the sender submitted, so it joins the P0053 immutable
-- set: 0154's guard is re-created with the column added (same message).
--
-- Values are pinned to CONTACT_FORM_LOCATIONS in
-- src/lib/contact-messages/labels.ts by website-messages-schema.test.ts.

alter table public.contact_messages
  add column if not exists form_location text;

alter table public.contact_messages
  drop constraint if exists contact_messages_form_location_check;
alter table public.contact_messages
  add constraint contact_messages_form_location_check
    check (form_location is null or form_location in ('home', 'contact'));

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
     or new.form_location is distinct from old.form_location
     or new.created_at is distinct from old.created_at then
    raise exception 'A website message cannot be edited — only its status, type, notes and booking link can change.'
      using errcode = 'P0053';
  end if;
  return new;
end;
$$;

-- As 0154 left it: a trigger function needs no EXECUTE grant.
revoke all on function public.contact_messages_guard_immutable() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Post-conditions
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'contact_messages'
       and column_name = 'form_location'
  ) then
    raise exception '0156 post-check: contact_messages.form_location is missing';
  end if;
  if position('form_location' in pg_get_functiondef('public.contact_messages_guard_immutable()'::regprocedure)) = 0 then
    raise exception '0156 post-check: the P0053 guard does not cover form_location';
  end if;
  if has_table_privilege('anon', 'public.contact_messages', 'insert')
     or has_table_privilege('anon', 'public.contact_messages', 'select') then
    raise exception '0156 post-check: anon can reach contact_messages';
  end if;
end;
$$;
