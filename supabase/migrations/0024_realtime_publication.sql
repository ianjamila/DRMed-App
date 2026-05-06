-- =============================================================================
-- 0024_realtime_publication.sql
-- =============================================================================
-- Adds appointments + test_requests to the supabase_realtime publication
-- so authenticated staff clients can subscribe to live INSERT events
-- via Supabase Realtime. Existing RLS continues to gate which rows each
-- subscriber actually receives — Realtime is RLS-aware on private
-- channels.
--
-- The DO blocks are idempotent: in environments where these tables are
-- already in the publication (e.g. a fresh Supabase project that
-- defaults to "all tables"), the duplicate_object exception is
-- swallowed.
-- =============================================================================

do $$
begin
  alter publication supabase_realtime add table public.appointments;
exception when duplicate_object then null;
end$$;

do $$
begin
  alter publication supabase_realtime add table public.test_requests;
exception when duplicate_object then null;
end$$;
