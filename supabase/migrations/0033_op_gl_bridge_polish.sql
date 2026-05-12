-- =============================================================================
-- 0033_op_gl_bridge_polish.sql
-- =============================================================================
-- Code-quality fix-forward (12.2.1d) for cumulative state of 703b4f7 +
-- 121dc9b + 135272d. Addresses four items surfaced in reviewer pass:
--
--   IMPORTANT #1 — bridge_test_request_released: add Suspense audit-log path
--   for both resolve_revenue_account and resolve_discount_account results,
--   matching the existing pattern in bridge_payment_insert. RA 10173 requires
--   that every unresolved CoA routing be traceable. One audit_log row is
--   written per Suspense hit (revenue and discount are independent checks).
--
--   IMPORTANT #2 — smoke test cleanup: handled in the .sql test file (no
--   migration needed). See supabase/tests/0030_op_gl_bridge_smoke.sql.
--
--   MINOR #4 — coa_uuid_for_code: convert from language sql (returns null on
--   miss) to language plpgsql with explicit RAISE. Spec says "strict by-code
--   lookup. Raises if not found." Callers that fall through to '9999' Suspense
--   are safe because Suspense is seeded in 0028 and protected by the P0006
--   delete-block trigger.
--
--   MINOR #5 — 0030 non-idempotent seeds: documented below. Do NOT retroactively
--   edit 0030; this comment is the forward record.
--
--   MINOR #6 — 0031 unguarded je_year_counters reset: a sanity-check RAISE
--   NOTICE is emitted at the top of this migration if real 2026 JEs exist,
--   so that an operator running db:reset against a DB with live data is warned
--   before the counter was already reset in 0031.
-- =============================================================================

-- =============================================================================
-- MINOR #5 NOTE: 0030 seed inserts (payment_method_account_map, CoA 1090) are
-- NOT idempotent. Running `supabase db reset` on a DB that already applied 0030
-- will re-run those inserts and fail with unique-constraint violations. This is
-- expected behavior for a migration-based schema; db:reset intentionally drops
-- and rebuilds. If you need to re-seed a live DB, use INSERT ... ON CONFLICT DO
-- NOTHING in a separate seed file rather than re-running the migration.
-- =============================================================================

-- =============================================================================
-- MINOR #6 SANITY CHECK: warn if real 2026 JEs exist.
-- This check is informational only — it cannot undo the counter reset in 0031.
-- If this notice fires on a production DB, an operator should manually audit
-- je_year_counters and set next_n to (max existing JE number for 2026) + 1.
-- =============================================================================
do $$
declare v_real_je_count int;
begin
  select count(*) into v_real_je_count
    from public.journal_entries
   where status = 'posted'
     and extract(year from posting_date) = 2026
     and entry_number not like '%SMOKE%';
  if v_real_je_count > 0 then
    raise notice
      'SANITY WARNING (0033): % real 2026 JEs found. Migration 0031 reset '
      'je_year_counters.next_n to 1. If that reset ran AFTER these JEs were '
      'posted, duplicate JE numbers may exist. Manually set next_n = (max + 1) '
      'for fiscal_year = 2026.',
      v_real_je_count;
  end if;
end;
$$;

-- =============================================================================
-- MINOR #4 — coa_uuid_for_code: raise on not-found (was: return null)
-- =============================================================================

create or replace function public.coa_uuid_for_code(p_code text)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  select id into v_id from public.chart_of_accounts where code = p_code;
  if v_id is null then
    raise exception 'CoA code % not found.', p_code;
  end if;
  return v_id;
end;
$$;

-- =============================================================================
-- IMPORTANT #1 — bridge_test_request_released: add Suspense audit-log paths
-- =============================================================================
-- Full CREATE OR REPLACE of the function. Body is structurally identical to
-- 0030 except for the two Suspense audit-log blocks added after the
-- resolve_revenue_account / resolve_discount_account calls and the two new
-- v_suspense_* variable declarations.

create or replace function public.bridge_test_request_released()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_hmo              boolean;
  v_service_kind        text;
  v_revenue_id          uuid;
  v_discount_id         uuid;
  v_ar_hmo_id           uuid;
  v_ar_patient_id       uuid;
  v_base                numeric(14,2);
  v_discount            numeric(14,2);
  v_final               numeric(14,2);
  v_hmo_approved        numeric(14,2);
  v_patient_share       numeric(14,2);
  v_je_id               uuid;
  v_existing_je         uuid;
  v_line_order          int := 1;
  v_suspense_id         uuid;
  v_revenue_suspense    boolean := false;
  v_discount_suspense   boolean := false;
begin
  -- Idempotency.
  select id into v_existing_je
    from public.journal_entries
    where source_kind = 'test_request'
      and source_id = NEW.id
      and status = 'posted'
    for update;
  if v_existing_je is not null then
    return NEW;
  end if;

  -- Context.
  select (v.hmo_provider_id is not null) into v_is_hmo
    from public.visits v
    where v.id = NEW.visit_id;

  select s.kind into v_service_kind
    from public.services s
    where s.id = NEW.service_id;

  v_base          := coalesce(NEW.base_price_php, 0);
  v_discount      := coalesce(NEW.discount_amount_php, 0);
  v_final         := coalesce(NEW.final_price_php, v_base - v_discount);
  v_hmo_approved  := case when v_is_hmo then coalesce(NEW.hmo_approved_amount_php, 0) else 0 end;
  v_patient_share := v_final - v_hmo_approved;

  v_revenue_id    := public.resolve_revenue_account(v_service_kind);
  v_discount_id   := public.resolve_discount_account(v_service_kind);
  v_ar_hmo_id     := public.resolve_ar_account(true);
  v_ar_patient_id := public.resolve_ar_account(false);

  -- Suspense detection: compare resolved IDs to the 9999 Suspense account.
  -- Both checks are independent; if either resolves to Suspense, an audit row
  -- is written so an operator can reclassify.
  v_suspense_id        := public.coa_uuid_for_code('9999');
  v_revenue_suspense   := (v_revenue_id  = v_suspense_id);
  v_discount_suspense  := (v_discount_id = v_suspense_id);

  -- Header: insert as draft first so je_lines_balance_check doesn't fire mid-insertion.
  insert into public.journal_entries (
    posting_date, description, status, source_kind, source_id, created_by
  )
  values (
    coalesce(NEW.released_at::date, current_date),
    'Test request released: ' || coalesce(v_service_kind, 'unknown'),
    'draft',
    'test_request',
    NEW.id,
    NEW.released_by
  )
  returning id into v_je_id;

  -- Lines, dropping zero-amount entries.
  if v_hmo_approved > 0 then
    insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
      values (v_je_id, v_ar_hmo_id, v_hmo_approved, 0, v_line_order);
    v_line_order := v_line_order + 1;
  end if;
  if v_patient_share > 0 then
    insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
      values (v_je_id, v_ar_patient_id, v_patient_share, 0, v_line_order);
    v_line_order := v_line_order + 1;
  end if;
  if v_discount > 0 then
    insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
      values (v_je_id, v_discount_id, v_discount, 0, v_line_order);
    v_line_order := v_line_order + 1;
  end if;
  insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
    values (v_je_id, v_revenue_id, 0, v_base, v_line_order);

  -- Flip to posted — je_status_balance_check validates full balance here.
  update public.journal_entries set status = 'posted' where id = v_je_id;

  -- Suspense audit: one row per Suspense hit (revenue and discount are independent).
  -- Matches the same pattern used in bridge_payment_insert for RA 10173 traceability.
  if v_revenue_suspense then
    insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
    values (
      NEW.released_by,
      'staff',
      'coa.suspense_post',
      'journal_entries',
      v_je_id,
      jsonb_build_object(
        'source_kind',      'test_request',
        'source_id',        NEW.id,
        'reason',           'no mapping for service.kind in resolve_revenue_account',
        'attempted_lookup', v_service_kind
      )
    );
  end if;

  if v_discount_suspense then
    insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
    values (
      NEW.released_by,
      'staff',
      'coa.suspense_post',
      'journal_entries',
      v_je_id,
      jsonb_build_object(
        'source_kind',      'test_request',
        'source_id',        NEW.id,
        'reason',           'no mapping for service.kind in resolve_discount_account',
        'attempted_lookup', v_service_kind
      )
    );
  end if;

  return NEW;
end;
$$;
