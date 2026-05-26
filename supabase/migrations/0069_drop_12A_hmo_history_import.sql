-- =============================================================================
-- 0069_drop_12A_hmo_history_import.sql
-- =============================================================================
-- Reverts the 12.A "HMO history import" feature shipped by migrations
-- 0035-0037. The feature was rolled back manually on the remote database
-- after UAT (zero JEs of source_kind = 'hmo_history_opening' were ever
-- posted in production), but the migration records remained and the local
-- stack still applied the schema. This migration brings local in sync
-- with the rolled-back remote state.
--
-- On remote:  every DROP IF EXISTS is a no-op, and the bridge function
--             bodies already match the form this migration restores.
-- On local:   this is the actual cleanup — drops the staging tables,
--             helper columns, partial indexes, and restores the bridge
--             functions to their pre-0035 form.
--
-- The 'hmo_history_opening' value on the je_source_kind enum is left in
-- place — PostgreSQL doesn't allow ALTER TYPE DROP VALUE, and the value
-- is unreferenced so it's harmless to keep around. 0037's index predicate
-- exclusion of 'hmo_history_opening' is also kept (already drift-free).
-- =============================================================================

-- ---- 0035 staging tables ----------------------------------------------------

drop table if exists public.hmo_history_staging   cascade;
drop table if exists public.hmo_provider_aliases  cascade;
drop table if exists public.hmo_service_aliases   cascade;
drop table if exists public.hmo_import_runs       cascade;

-- ---- 0036 commit function ---------------------------------------------------

drop function if exists public.commit_hmo_history_run(uuid);

-- ---- 0035 columns added to hmo_claim_* --------------------------------------

alter table public.hmo_claim_items   drop column if exists hmo_approval_date;
alter table public.hmo_claim_batches drop column if exists import_run_id;
alter table public.hmo_claim_batches drop column if exists historical_source;

-- ---- 0035 is_historical infrastructure on patients / visits / test_requests

drop index if exists public.idx_patients_active;
drop index if exists public.idx_visits_active;
drop index if exists public.idx_test_requests_active;

alter table public.patients
  drop constraint if exists patients_birthdate_required_when_not_historical;

alter table public.patients      drop column if exists is_historical;
alter table public.visits        drop column if exists is_historical;
alter table public.test_requests drop column if exists is_historical;

-- ---- Restore bridge functions to pre-0035 form ------------------------------
-- The 12.A modifications added is_historical-aware branches; those are now
-- gone on remote (the function bodies revert to the 0034 form). Replacing
-- the function definitions here on local matches that state.

create or replace function public.bridge_payment_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_hmo         boolean;
  v_cash_id        uuid;
  v_ar_id          uuid;
  v_je_id          uuid;
  v_existing_je    uuid;
  v_suspense_id    uuid;
  v_used_suspense  boolean := false;
begin
  select id into v_existing_je
    from public.journal_entries
    where source_kind = 'payment'
      and source_id = NEW.id
      and status = 'posted'
    for update;
  if v_existing_je is not null then
    return NEW;
  end if;

  select (v.hmo_provider_id is not null) into v_is_hmo
    from public.visits v
    where v.id = NEW.visit_id;

  v_cash_id := public.resolve_cash_account(NEW.method);
  v_ar_id   := public.resolve_ar_account(coalesce(v_is_hmo, false));

  v_suspense_id := public.coa_uuid_for_code('9999');
  v_used_suspense := (v_cash_id = v_suspense_id);

  -- Insert as draft first so je_lines_balance_check doesn't fire mid-insertion.
  insert into public.journal_entries (
    posting_date, description, status, source_kind, source_id, created_by
  )
  values (
    NEW.received_at::date,
    'Payment received via ' || NEW.method,
    'draft',
    'payment',
    NEW.id,
    NEW.received_by
  )
  returning id into v_je_id;

  insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
  values
    (v_je_id, v_cash_id, NEW.amount_php, 0, 1),
    (v_je_id, v_ar_id,   0, NEW.amount_php, 2);

  -- Flip to posted — je_status_balance_check validates full balance here.
  update public.journal_entries set status = 'posted' where id = v_je_id;

  if v_used_suspense then
    insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
    values (
      NEW.received_by,
      'staff',
      'coa.suspense_post',
      'journal_entries',
      v_je_id,
      jsonb_build_object(
        'source_kind', 'payment',
        'source_id', NEW.id,
        'reason', 'no payment_method_account_map row',
        'attempted_lookup', NEW.method
      )
    );
  end if;

  return NEW;
end;
$$;

create or replace function public.bridge_hmo_claim_resolution_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item            public.hmo_claim_items%rowtype;
  v_batch           public.hmo_claim_batches%rowtype;
  v_dr_account      uuid;
  v_cr_account      uuid;
  v_dr_code         text;
  v_cr_code         text := '1110';
  v_desc            text;
  v_je_id           uuid;
  v_existing_je     uuid;
begin
  -- Idempotency guard (mirrors 12.2).
  select id into v_existing_je
    from public.journal_entries
   where source_kind = 'hmo_claim_resolution'
     and source_id = NEW.id
     and status = 'posted'
   for update;
  if v_existing_je is not null then
    return NEW;
  end if;

  select * into v_item  from public.hmo_claim_items   where id = NEW.item_id;
  select * into v_batch from public.hmo_claim_batches where id = v_item.batch_id;

  if NEW.destination = 'patient_bill' then
    v_dr_code := '1100';
  else
    v_dr_code := '6920';
  end if;

  v_dr_account := public.coa_uuid_for_code(v_dr_code);
  v_cr_account := public.coa_uuid_for_code(v_cr_code);

  v_desc := format(
    'HMO claim resolved → %s — batch %s item %s',
    case NEW.destination when 'patient_bill' then 'patient bill' else 'write-off' end,
    coalesce(v_batch.reference_no, v_batch.id::text),
    NEW.item_id::text
  );

  -- Insert as draft first to defer balance-check until all lines exist.
  insert into public.journal_entries (
    posting_date, description, status, source_kind, source_id, created_by
  )
  values (
    coalesce(NEW.resolved_at::date, current_date),
    v_desc,
    'draft',
    'hmo_claim_resolution',
    NEW.id,
    NEW.resolved_by
  )
  returning id into v_je_id;

  insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
  values
    (v_je_id, v_dr_account, NEW.amount_php, 0, 1),
    (v_je_id, v_cr_account, 0, NEW.amount_php, 2);

  update public.journal_entries set status = 'posted' where id = v_je_id;

  return NEW;
end;
$$;
