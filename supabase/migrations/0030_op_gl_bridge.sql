-- =============================================================================
-- 0030_op_gl_bridge.sql
-- =============================================================================
-- Phase 12.2: Operational → GL bridge. Wires payments and test_requests to
-- the journal_entries spine via Postgres triggers. Adds soft-void semantics
-- to payments, a partial unique index for idempotent replay, a payment-method
-- routing table, helper resolvers, five bridge functions, four guard triggers
-- (P0004 edit-after-JE, P0005 inactive-account, P0006 CoA-delete, P0007
-- un-void), and a bridge_replay_summary inspection function for batch tooling.
--
-- After this migration:
--   * Inserting a payment fires a JE (DR cash / CR AR-Patient or AR-HMO).
--   * Releasing a test_request fires a JE (revenue recognition, supports
--     HMO partial-approval splits and discount contra-lines).
--   * Voiding a payment or cancelling a release fires a paired reversal JE.
--   * Replay (12.A) is "INSERT into operational table" — bridge handles JE.
--
-- NOTE: services.kind in production uses values: 'lab_test', 'lab_package',
-- 'doctor_consultation', 'doctor_procedure', 'home_service', 'vaccine'.
-- Resolver functions map these to revenue/discount CoA accounts accordingly.
-- =============================================================================

-- ---- payments: soft-void columns -------------------------------------------

alter table public.payments
  add column voided_at  timestamptz,
  add column voided_by  uuid references public.staff_profiles(id),
  add column void_reason text;

create index idx_payments_active
  on public.payments (visit_id)
  where voided_at is null;

-- ---- payment_method_account_map --------------------------------------------
-- Admin-editable lookup that maps each payments.method value to a cash CoA
-- account. Seeded below; admin manages via /staff/admin/accounting/payment-routing.

create table public.payment_method_account_map (
  id              uuid primary key default gen_random_uuid(),
  payment_method  text unique not null,
  account_id      uuid not null references public.chart_of_accounts(id),
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger trg_payment_method_account_map_updated_at
  before update on public.payment_method_account_map
  for each row execute function public.touch_updated_at();

alter table public.payment_method_account_map enable row level security;

create policy "payment_method_account_map: admin read"
  on public.payment_method_account_map
  for select to authenticated
  using (public.has_role(array['admin']));

-- ---- CoA additions for 12.2 ------------------------------------------------

insert into public.chart_of_accounts (code, name, type, normal_balance, description)
values (
  '1090',
  'Cash — HMO Settlements Pending',
  'asset',
  'debit',
  'Clearing account for method=hmo payments. Admin reclassifies to BPI/BDO via manual JE in 12.7 once bank deposit is identified.'
);

-- Broaden 4920 to cover doctor procedures as well as consultations.
update public.chart_of_accounts
   set description = 'Senior/PWD and promotional discounts on consultations and procedures'
 where code = '4920';

-- ---- Idempotency guard for non-reversal posted JEs --------------------------
-- Prevents two posted JEs from claiming the same operational source row.
-- Excludes reversal JEs (identified via the `reverses` FK, not source_id)
-- and entries with null source_id. Excludes `status='reversed'` so that
-- re-release after cancel can post a fresh JE without colliding with the
-- original (which has been flipped to reversed by the cancel trigger).

create unique index journal_entries_one_posted_per_source
  on public.journal_entries (source_kind, source_id)
  where status = 'posted'
    and source_kind != 'reversal'
    and source_id is not null;

-- ---- Helper resolvers ------------------------------------------------------

-- Strict by-code lookup; used internally by the resolve_* helpers.
create or replace function public.coa_uuid_for_code(p_code text)
returns uuid
language sql
stable
as $$
  select id from public.chart_of_accounts where code = p_code;
$$;

-- Resolve a payments.method value to its cash CoA account_id.
-- Falls back to 9999 Suspense if the mapping is missing or the mapped
-- account itself doesn't exist.
create or replace function public.resolve_cash_account(p_method text)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_account_id uuid;
begin
  select map.account_id into v_account_id
    from public.payment_method_account_map map
    where map.payment_method = p_method;
  if v_account_id is null then
    v_account_id := public.coa_uuid_for_code('9999');
  end if;
  return v_account_id;
end;
$$;

-- Resolve service.kind → revenue CoA. Fallback to 9999 Suspense.
-- Matches the actual services.kind check constraint values in production:
-- 'lab_test', 'lab_package' → 4100 Lab Tests Sales Revenue
-- 'doctor_consultation'     → 4200 Doctor Consultation Sales Revenue
-- 'doctor_procedure'        → 4500 Procedures
create or replace function public.resolve_revenue_account(p_service_kind text)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_code text;
begin
  v_code := case p_service_kind
    when 'lab_test'            then '4100'
    when 'lab_package'         then '4100'
    when 'doctor_consultation' then '4200'
    when 'doctor_procedure'    then '4500'
    else null
  end;
  if v_code is null then
    return public.coa_uuid_for_code('9999');
  end if;
  return coalesce(public.coa_uuid_for_code(v_code), public.coa_uuid_for_code('9999'));
end;
$$;

-- Resolve service.kind → discount contra-revenue CoA.
-- Lab services (lab_test, lab_package) use 4910; everything else
-- (doctor_consultation, doctor_procedure, and any future kind) lumps into 4920.
create or replace function public.resolve_discount_account(p_service_kind text)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_code text;
begin
  v_code := case
    when p_service_kind in ('lab_test', 'lab_package') then '4910'
    else '4920'
  end;
  return coalesce(public.coa_uuid_for_code(v_code), public.coa_uuid_for_code('9999'));
end;
$$;

-- Resolve AR account: 1110 for HMO visits, 1100 for non-HMO.
create or replace function public.resolve_ar_account(p_is_hmo boolean)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_is_hmo then
    return public.coa_uuid_for_code('1110');
  else
    return public.coa_uuid_for_code('1100');
  end if;
end;
$$;

-- ---- Bridge: payments ------------------------------------------------------

-- Fires AFTER INSERT on payments. Constructs the cash-in JE:
--   DR <cash-account-for-method>
--   CR <AR-Patients or AR-HMO based on visit.hmo_provider_id>
--
-- Pattern: insert as 'draft', insert all lines, then flip to 'posted'.
-- This avoids the je_lines_balance_check P0001 that fires on each AFTER INSERT
-- on journal_lines when status='posted' with only a partial set of lines.
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
  -- Idempotency check: skip if a posted JE already exists for this payment.
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

-- Fires AFTER UPDATE on payments when voided_at flips NULL -> non-NULL.
-- Two-step: flip the original JE to status='reversed', insert mirrored reversal.
-- Pattern: insert reversal as 'draft', insert mirrored lines, flip to 'posted'.
create or replace function public.bridge_payment_void()
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
  -- Find the original posted payment JE.
  select id, entry_number into v_original_je, v_orig_number
    from public.journal_entries
    where source_kind = 'payment'
      and source_id = NEW.id
      and status = 'posted'
    for update;
  if v_original_je is null then
    -- Defensive: payment was voided but no JE exists. Skip; nothing to reverse.
    return NEW;
  end if;

  -- Insert the reversal header as draft first.
  insert into public.journal_entries (
    posting_date, description, status, source_kind, source_id, reverses, created_by
  )
  values (
    NEW.voided_at::date,
    'Reversal of ' || v_orig_number || ': ' || coalesce(NEW.void_reason, '(no reason)'),
    'draft',
    'reversal',
    null,
    v_original_je,
    NEW.voided_by
  )
  returning id into v_reversal_je;

  -- Mirror original lines with swapped debit/credit.
  insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
  select v_reversal_je, account_id, credit_php, debit_php, line_order
    from public.journal_lines
    where entry_id = v_original_je
    order by line_order;

  -- Flip reversal to posted (validates balance).
  update public.journal_entries set status = 'posted' where id = v_reversal_je;

  -- Flip original to reversed and link the reversal back.
  update public.journal_entries
    set status = 'reversed',
        reversed_by = v_reversal_je
    where id = v_original_je;

  return NEW;
end;
$$;

-- Fires BEFORE DELETE on payments. Safety net for the gift-code rollback path
-- and any future hard-delete scenarios. Posts a reversal JE if a posted JE
-- exists for this payment.
-- Pattern: insert reversal as 'draft', insert mirrored lines, flip to 'posted'.
create or replace function public.bridge_payment_delete()
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
  select id, entry_number into v_original_je, v_orig_number
    from public.journal_entries
    where source_kind = 'payment'
      and source_id = OLD.id
      and status = 'posted'
    for update;
  if v_original_je is null then
    return OLD;
  end if;

  insert into public.journal_entries (
    posting_date, description, status, source_kind, source_id, reverses, created_by
  )
  values (
    current_date,
    'Reversal of ' || v_orig_number || ': payment row deleted',
    'draft',
    'reversal',
    null,
    v_original_je,
    null
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

  return OLD;
end;
$$;

-- ---- Bridge: test_requests --------------------------------------------------

-- Fires AFTER UPDATE on test_requests when OLD.status != 'released' AND
-- NEW.status = 'released'. Constructs the revenue recognition JE:
--   DR AR-HMO (hmo_approved_amount_php, if > 0)
--   DR AR-Patients (final_price - hmo_approved, if > 0)
--   DR Discount (discount_amount_php, if > 0)
--   CR Revenue (base_price_php)
create or replace function public.bridge_test_request_released()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_hmo         boolean;
  v_service_kind   text;
  v_revenue_id     uuid;
  v_discount_id    uuid;
  v_ar_hmo_id      uuid;
  v_ar_patient_id  uuid;
  v_base           numeric(14,2);
  v_discount       numeric(14,2);
  v_final          numeric(14,2);
  v_hmo_approved   numeric(14,2);
  v_patient_share  numeric(14,2);
  v_je_id          uuid;
  v_existing_je    uuid;
  v_line_order     int := 1;
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

  return NEW;
end;
$$;

-- Fires AFTER UPDATE on test_requests when OLD.status = 'released' AND
-- NEW.status = 'cancelled'. Same flip-and-reverse pattern as void.
-- Pattern: insert reversal as 'draft', insert mirrored lines, flip to 'posted'.
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

-- ---- Guard triggers --------------------------------------------------------

-- P0004: cannot edit payment fields after a JE has posted (void instead).
-- voided_at/voided_by/void_reason are exempt — voiding is allowed.
create or replace function public.payments_block_post_je_edits()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1 from public.journal_entries
    where source_kind = 'payment' and source_id = NEW.id and status = 'posted'
  ) then
    if NEW.amount_php is distinct from OLD.amount_php
       or NEW.method is distinct from OLD.method
       or NEW.visit_id is distinct from OLD.visit_id
       or NEW.received_at is distinct from OLD.received_at then
      raise exception
        'Cannot edit payment fields after JE has posted. Void and re-create instead.'
        using errcode = 'P0004';
    end if;
  end if;
  return NEW;
end;
$$;

-- P0007: cannot un-void a payment. Create a new payment instead.
create or replace function public.payments_block_unvoid()
returns trigger
language plpgsql
as $$
begin
  if OLD.voided_at is not null and NEW.voided_at is null then
    raise exception
      'Cannot un-void a payment. Create a new payment instead.'
      using errcode = 'P0007';
  end if;
  return NEW;
end;
$$;

-- P0005: cannot post a journal_line to an inactive CoA account.
create or replace function public.journal_lines_block_inactive_account()
returns trigger
language plpgsql
as $$
declare
  v_active boolean;
  v_code   text;
begin
  select is_active, code into v_active, v_code
    from public.chart_of_accounts
    where id = NEW.account_id;
  if not v_active then
    raise exception
      'Account % is inactive and cannot accept new postings.', v_code
      using errcode = 'P0005';
  end if;
  return NEW;
end;
$$;

-- P0006: CoA is append-only. Deactivate via is_active = false instead.
create or replace function public.chart_of_accounts_block_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'Accounts are append-only. Use is_active = false to soft-disable instead.'
    using errcode = 'P0006';
end;
$$;

-- ---- Triggers --------------------------------------------------------------

create trigger trg_bridge_payment_insert
  after insert on public.payments
  for each row execute function public.bridge_payment_insert();

create trigger trg_bridge_payment_void
  after update on public.payments
  for each row
  when (OLD.voided_at is null and NEW.voided_at is not null)
  execute function public.bridge_payment_void();

create trigger trg_bridge_payment_delete
  before delete on public.payments
  for each row execute function public.bridge_payment_delete();

create trigger trg_bridge_test_request_released
  after update on public.test_requests
  for each row
  when (OLD.status is distinct from 'released' and NEW.status = 'released')
  execute function public.bridge_test_request_released();

create trigger trg_bridge_test_request_cancelled
  after update on public.test_requests
  for each row
  when (OLD.status = 'released' and NEW.status = 'cancelled')
  execute function public.bridge_test_request_cancelled();

create trigger trg_payments_block_post_je_edits
  before update on public.payments
  for each row execute function public.payments_block_post_je_edits();

create trigger trg_payments_block_unvoid
  before update on public.payments
  for each row execute function public.payments_block_unvoid();

create trigger trg_journal_lines_block_inactive_account
  before insert on public.journal_lines
  for each row execute function public.journal_lines_block_inactive_account();

create trigger trg_chart_of_accounts_block_delete
  before delete on public.chart_of_accounts
  for each row execute function public.chart_of_accounts_block_delete();

-- ---- Seed payment_method_account_map ---------------------------------------
-- One row per payments.method enum value. Admin can change via
-- /staff/admin/accounting/payment-routing without a migration.

insert into public.payment_method_account_map (payment_method, account_id, notes)
values
  ('cash',          public.coa_uuid_for_code('1010'), 'Daily till'),
  ('gcash',         public.coa_uuid_for_code('1030'), 'GCash wallet'),
  ('maya',          public.coa_uuid_for_code('1030'), 'Maya lumped into GCash wallet for now'),
  ('card',          public.coa_uuid_for_code('1010'), 'Card receipts treated as cash on hand; refine when Veritas settlement is modelled'),
  ('bank_transfer', public.coa_uuid_for_code('1020'), 'Generic bank transfer; defaults to BPI'),
  ('bpi',           public.coa_uuid_for_code('1020'), 'BPI operating account'),
  ('maybank',       public.coa_uuid_for_code('1020'), 'No Maybank account seeded; lumped into BPI'),
  ('hmo',           public.coa_uuid_for_code('1090'), 'HMO settlement clearing account; reclassify to BPI/BDO via manual JE');

-- ---- Replay-batch inspection helper ----------------------------------------
-- Returns a single JSON document summarising JE activity in a time window.
-- Used by 12.A's import code, admin diagnostics, and the smoke test.

create or replace function public.bridge_replay_summary(
  p_start timestamptz,
  p_end   timestamptz
)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'window', jsonb_build_object('start', p_start, 'end', p_end),
    'je_count', (
      select count(*) from public.journal_entries
      where created_at between p_start and p_end and status = 'posted'
    ),
    'suspense_postings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'entry_number', je.entry_number,
        'source_kind', je.source_kind,
        'source_id', je.source_id,
        'amount', jl.debit_php + jl.credit_php
      ))
      from public.journal_entries je
      join public.journal_lines jl on jl.entry_id = je.id
      join public.chart_of_accounts coa on coa.id = jl.account_id
      where je.created_at between p_start and p_end
        and coa.code = '9999'
        and je.status = 'posted'
    ), '[]'::jsonb),
    'totals_by_account', coalesce((
      select jsonb_object_agg(coa.code,
        jsonb_build_object('debit', sum_d, 'credit', sum_c))
      from (
        select jl.account_id,
          sum(jl.debit_php) as sum_d,
          sum(jl.credit_php) as sum_c
        from public.journal_lines jl
        join public.journal_entries je on je.id = jl.entry_id
        where je.created_at between p_start and p_end
          and je.status = 'posted'
        group by jl.account_id
      ) agg
      join public.chart_of_accounts coa on coa.id = agg.account_id
    ), '{}'::jsonb),
    'unbalanced_count', (
      select count(*) from (
        select je.id
        from public.journal_entries je
        join public.journal_lines jl on jl.entry_id = je.id
        where je.created_at between p_start and p_end
          and je.status = 'posted'
        group by je.id
        having sum(jl.debit_php) <> sum(jl.credit_php)
      ) unbal
    )
  );
$$;
