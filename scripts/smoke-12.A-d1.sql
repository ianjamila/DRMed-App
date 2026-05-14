-- =============================================================================
-- smoke-12.A-d1.sql
-- =============================================================================
-- Dispatch-1 smoke: verifies the bridge bypass session-flag mechanism.
--
-- Approach: pick a real visit + service that already has an HMO claim and a
-- payment row. Insert a small synthetic payment with the bypass flag set, then
-- assert that no JE was posted for it. Clean up at the end.
--
-- Run against a local Supabase instance (supabase db reset; supabase db push).
-- =============================================================================

\set ON_ERROR_STOP on

begin;

-- ---- Fixture: a known HMO visit + service we can attach a payment to ----
do $$
declare
  v_visit_id   uuid;
  v_payment_id uuid;
  v_je_count   int;
begin
  -- Pick any HMO visit. If there's no operational HMO visit yet (fresh repo),
  -- create one. This block needs at least one auth.users row and one
  -- staff_profiles row to satisfy FKs; assume the seed fixtures provide them.
  select id into v_visit_id
    from public.visits
   where hmo_provider_id is not null
   order by created_at desc
   limit 1;

  -- Schema-presence assertion: even when no fixture visit exists, the
  -- migration should have created the staging tables and bypass guards.
  perform 1 from public.hmo_import_runs limit 0;       -- raises if table missing
  perform 1 from public.hmo_history_staging limit 0;   -- raises if table missing
  if not exists (
    select 1 from pg_proc where proname = 'bridge_payment_insert'
      and prosrc like '%skip_bridge_historical%'
  ) then
    raise exception 'schema check FAIL: bridge_payment_insert lacks the bypass guard';
  end if;

  if v_visit_id is null then
    raise notice 'no operational HMO visit found; smoke needs fixture seed (skipping for fresh-clone path)';
    return;
  end if;

  -- Set the bypass flag (transaction-scoped via SET LOCAL).
  set local app.skip_bridge_historical = 'true';

  -- Insert a synthetic payment.
  insert into public.payments (visit_id, amount_php, method, reference_number,
                                received_by, received_at, notes)
  values (v_visit_id, 1.00, 'hmo', 'SMOKE-12A-D1',
          (select id from public.staff_profiles where role = 'admin' order by created_at limit 1),
          now(), '[historical-import:smoke-d1] bypass test')
  returning id into v_payment_id;

  -- Assert: NO JE was posted for this payment.
  select count(*) into v_je_count
    from public.journal_entries
   where source_kind = 'payment'
     and source_id = v_payment_id;

  if v_je_count <> 0 then
    raise exception 'smoke FAIL: bypass leaked — found % JEs for synthetic payment', v_je_count;
  end if;

  raise notice 'smoke OK: bridge_payment_insert correctly skipped under bypass flag';

  -- ---- Now repeat without the flag and confirm a JE IS posted ----
  -- (Clear the flag by setting it to empty.)
  set local app.skip_bridge_historical = '';

  insert into public.payments (visit_id, amount_php, method, reference_number,
                                received_by, received_at, notes)
  values (v_visit_id, 1.00, 'hmo', 'SMOKE-12A-D1-control',
          (select id from public.staff_profiles where role = 'admin' order by created_at limit 1),
          now(), 'control: bypass off')
  returning id into v_payment_id;

  select count(*) into v_je_count
    from public.journal_entries
   where source_kind = 'payment'
     and source_id = v_payment_id;

  if v_je_count <> 1 then
    raise exception 'smoke FAIL: control payment did not get its JE (count=%)', v_je_count;
  end if;

  raise notice 'smoke OK: bridge_payment_insert correctly fires when bypass is off';
end$$;

-- ---- Cleanup: roll everything back ----
rollback;
