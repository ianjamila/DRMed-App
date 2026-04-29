-- =============================================================================
-- 0004_contact_messages.sql
-- =============================================================================
-- Public contact form submissions on the marketing site.
-- =============================================================================

create table public.contact_messages (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  email       text,
  phone       text,
  subject     text,
  message     text not null,
  ip_address  inet,
  user_agent  text,
  handled     boolean not null default false,
  handled_by  uuid references auth.users(id),
  handled_at  timestamptz,
  created_at  timestamptz not null default now()
);

create index idx_contact_messages_created_at on public.contact_messages(created_at desc);
create index idx_contact_messages_handled    on public.contact_messages(handled)
  where handled = false;

alter table public.contact_messages enable row level security;

-- Anyone can submit the form. Rate limiting is enforced in the server action
-- (Phase 6 adds an Edge function for IP-based throttling).
create policy "contact_messages: public insert"
  on public.contact_messages for insert to anon, authenticated
  with check (true);

-- Reception and admin can read and mark handled.
create policy "contact_messages: reception/admin manage"
  on public.contact_messages for all to authenticated
  using (public.has_role(array['reception', 'admin']))
  with check (public.has_role(array['reception', 'admin']));
