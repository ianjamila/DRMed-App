-- =============================================================================
-- 0015_newsletter.sql
-- =============================================================================
-- Phase 14: marketing newsletter. Public visitors opt in via the marketing
-- site (homepage footer + /newsletter), admin composes campaigns and sends
-- via the existing Resend integration. RA 10173 requires explicit consent
-- (captured here as consent_at + consent_ip) and one-click unsubscribe
-- (each subscriber gets a stable hex token).
--
-- Public opt-in and unsubscribe both go through Server Actions backed by
-- the service-role client — anon never writes to these tables directly,
-- so RLS stays admin-only on both sides.
-- =============================================================================

create table public.subscribers (
  id                  uuid primary key default gen_random_uuid(),
  email               text not null unique
                        check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  source              text not null,
  consent_at          timestamptz not null default now(),
  consent_ip          inet,
  unsubscribed_at     timestamptz,
  unsubscribe_token   text not null unique
                        default encode(gen_random_bytes(24), 'hex'),
  created_at          timestamptz not null default now()
);

-- Partial index over the active set — most queries filter "active = not yet
-- unsubscribed", and active subscribers are typically the smaller fraction
-- of long-running lists.
create index idx_subscribers_active
  on public.subscribers (created_at desc)
  where unsubscribed_at is null;

create index idx_subscribers_token on public.subscribers (unsubscribe_token);

create table public.newsletter_campaigns (
  id               uuid primary key default gen_random_uuid(),
  subject          text not null check (length(trim(subject)) > 0),
  body_md          text not null,
  body_html        text not null,
  sent_at          timestamptz,
  sent_by          uuid references auth.users(id) on delete set null,
  recipient_count  int,
  created_at       timestamptz not null default now()
);

create index idx_newsletter_campaigns_sent_at
  on public.newsletter_campaigns (sent_at desc);

alter table public.subscribers enable row level security;
alter table public.newsletter_campaigns enable row level security;

-- Admin-only direct access on both. The public opt-in / unsubscribe
-- endpoints use Server Actions + service-role client, not the anon key.
create policy "subscribers: admin all"
  on public.subscribers
  for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

create policy "newsletter_campaigns: admin all"
  on public.newsletter_campaigns
  for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));
