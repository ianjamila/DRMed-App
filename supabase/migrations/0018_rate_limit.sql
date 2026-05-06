-- =============================================================================
-- 0018_rate_limit.sql
-- =============================================================================
-- Phase 8: rate-limit ledger for the public-facing endpoints that don't
-- already have brute-force protection. Staff Supabase Auth has built-in
-- limits and visit_pins has failed_attempts + locked_until, so this table
-- mainly catches: patient PIN guessers (per IP), abusive booking
-- submissions, contact form spam, newsletter signup floods.
--
-- One row per attempt. The (bucket, identifier, attempted_at) index lets
-- the count-in-window query stay cheap even after months of accumulation.
-- A nightly cleanup is left to ops (or the next maintenance migration);
-- at clinic scale this table grows < 1k rows/day so no urgent need.
-- =============================================================================

create table public.rate_limit_attempts (
  id            bigserial primary key,
  bucket        text not null,
  identifier    text not null,
  attempted_at  timestamptz not null default now()
);

create index idx_rate_limit_lookup
  on public.rate_limit_attempts (bucket, identifier, attempted_at desc);

-- Service-role client only — public traffic goes through Server Actions
-- that already authorise themselves; no need to expose this table.
alter table public.rate_limit_attempts enable row level security;

create policy "rate_limit_attempts: admin read"
  on public.rate_limit_attempts
  for select to authenticated
  using (public.has_role(array['admin']));
