-- =============================================================================
-- 0041_bridge_skip_package_components.sql
-- =============================================================================
-- Phase 14 follow-on (14.1b) — patch the 12.2 GL bridge so it skips package
-- components introduced by migration 0040.
--
-- Background:
--   * Migration 0030 introduced bridge_test_request_released() and
--     bridge_test_request_cancelled() as AFTER UPDATE triggers on
--     test_requests. They post a revenue-recognition JE (or its reversal)
--     keyed off NEW.base_price_php / NEW.final_price_php.
--   * Migration 0033 polished bridge_test_request_released to add Suspense
--     audit-log paths. bridge_test_request_cancelled was not touched.
--   * Migration 0040 introduced package decomposition. A package header
--     (is_package_header = true, parent_id IS NULL) carries the full price.
--     Components (parent_id IS NOT NULL, is_package_header = false) have
--     base_price_php = 0 and final_price_php = 0 — they roll up to the
--     header for GL purposes.
--
-- Problem:
--   The bridge fires on EVERY component release/cancel and tries to write a
--   JE line with (debit, credit) = (0, base_price_php) = (0, 0), which
--   violates journal_lines_check1 (debit > 0 OR credit > 0). Component
--   release fails in production.
--
-- Fix:
--   Both bridge functions are replaced (CREATE OR REPLACE FUNCTION) with
--   versions that early-return when NEW.parent_id IS NOT NULL. The package
--   header continues to bridge normally (it carries the full price);
--   standalone test_requests (parent_id IS NULL, is_package_header = false)
--   also continue to bridge normally. The gate is parent_id-based, not
--   header-based, because the header is the only non-NULL-parent_id row
--   that DOES need to bridge.
--
-- The rest of each function's body is preserved byte-for-byte from its
-- previous definition (0033 for released, 0030 for cancelled). Only the
-- early-return guard is added at the top.
-- =============================================================================

-- ---- bridge_test_request_released (was last set in 0033) -------------------

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
  -- Phase 14: package components have final_price_php = 0 and roll up to
  -- their package header for GL purposes. The header gets the JE; components
  -- skip the bridge. Skipping here avoids writing (0, 0) JE lines that would
  -- violate journal_lines.debit > 0 OR credit > 0.
  if new.parent_id is not null then
    return new;
  end if;

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

-- ---- bridge_test_request_cancelled (was last set in 0030) ------------------

create or replace function public.bridge_test_request_cancelled()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_original_je  uuid;
  v_orig_number  text;
  v_reversal_je  uuid;
begin
  -- Phase 14: package components have final_price_php = 0 and roll up to
  -- their package header for GL purposes. The header gets the JE; components
  -- skip the bridge. Skipping here avoids writing (0, 0) JE lines that would
  -- violate journal_lines.debit > 0 OR credit > 0.
  if new.parent_id is not null then
    return new;
  end if;

  select id, entry_number into v_original_je, v_orig_number
    from public.journal_entries
    where source_kind = 'test_request'
      and source_id = NEW.id
      and status = 'posted'
    for update;
  if v_original_je is null then
    return NEW;
  end if;

  insert into public.journal_entries (
    posting_date, description, status, source_kind, source_id, reverses, created_by
  )
  values (
    current_date,
    'Reversal of ' || v_orig_number || ': test request cancelled',
    'draft',
    'reversal',
    null,
    v_original_je,
    NEW.released_by
  )
  returning id into v_reversal_je;

  insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
  select v_reversal_je, account_id, credit_php, debit_php, line_order
    from public.journal_lines
    where entry_id = v_original_je
    order by line_order;

  -- Flip reversal to posted (validates balance).
  update public.journal_entries set status = 'posted' where id = v_reversal_je;

  update public.journal_entries
    set status = 'reversed',
        reversed_by = v_reversal_je
    where id = v_original_je;

  return NEW;
end;
$$;
