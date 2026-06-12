-- =============================================================================
-- 0100_realtime_visits_payments.sql
-- =============================================================================
-- Adds visits + payments to the supabase_realtime publication so the
-- reception Queue page (/staff/visits/queue) updates live as visits move
-- between its stages. The stage a visit sits in is driven by its
-- payment_status (recalculated on every payments insert) and its
-- test_requests — so the queue needs to react to:
--   * payments INSERT      — a payment landing flips unpaid → paid
--   * visits UPDATE         — payment_status recalc on that visit row
--   * test_requests UPDATE  — already published (0024); lab/imaging progress
-- Existing RLS continues to gate which rows each subscriber receives —
-- Realtime is RLS-aware on private channels, and only Supabase-Auth'd staff
-- subscribe to this channel.
--
-- Mirrors 0024's idempotent DO blocks: where a table is already in the
-- publication (e.g. a fresh project that defaults to "all tables"), the
-- duplicate_object exception is swallowed.
-- =============================================================================

do $$
begin
  alter publication supabase_realtime add table public.visits;
exception when duplicate_object then null;
end$$;

do $$
begin
  alter publication supabase_realtime add table public.payments;
exception when duplicate_object then null;
end$$;
