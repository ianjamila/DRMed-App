-- =============================================================================
-- 0043_eod_cash_reconciliation.sql
-- =============================================================================
-- Phase 12.C: Daily cash reconciliation. Adds reception-facing end-of-day
-- close workflow, cash adjustments subledger, staff-advance receivable
-- subledger, and the GL bridge that turns each cash movement into a
-- balanced JE through the same pattern as 0030 (draft → lines → posted).
--
-- After this migration:
--   * /staff/payments/cash-drawer logs petty cash, salary advances, courier
--     payouts, and float adjustments. Each fires a balanced JE in-transaction.
--   * /staff/payments/eod closes the day; non-zero variance posts a cash
--     short/over JE.
--   * Closed (date, shift) combos are DB-locked (P0015) until admin reopens.
--   * salary_advance payouts mirror into staff_advances; 12.6 (payroll) will
--     draw down outstanding balances via payslip deductions.
--   * /staff/admin/accounting/cash-routing manages the kind → CoA map.
--   * /staff/admin/reports/{daily-revenue,staff-advances} are read-only views.
--
-- NOTE: Existing partial unique index from 0030
--   journal_entries_one_posted_per_source
-- already covers the two new source_kind values; no index change needed.
-- =============================================================================

-- ---- Enum additions --------------------------------------------------------
-- Must run before any function/trigger that references these values.
-- IMPORTANT: ALTER TYPE … ADD VALUE inside a transaction does NOT make the
-- new enum value visible to later statements in that same transaction in
-- PG <12. Supabase runs PG 15+, where the value IS visible — verified by
-- 12.3's migration 0034 (which used the same pattern). If you back-port
-- this to a PG <12 environment, split into two migrations.
alter type public.je_source_kind add value if not exists 'cash_adjustment';
alter type public.je_source_kind add value if not exists 'eod_close';

-- ---- cash_shifts -----------------------------------------------------------
create table public.cash_shifts (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,
  label       text not null,
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger trg_cash_shifts_updated_at
  before update on public.cash_shifts
  for each row execute function public.touch_updated_at();

alter table public.cash_shifts enable row level security;

create policy "cash_shifts: staff read"
  on public.cash_shifts
  for select to authenticated
  using (public.has_role(array['reception','admin']));

create policy "cash_shifts: admin write"
  on public.cash_shifts
  for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

insert into public.cash_shifts (code, label, sort_order)
values ('default', 'Default shift', 0)
on conflict (code) do nothing;

-- ---- accounting_settings (key-value) -----------------------------------------------
create table public.accounting_settings (
  id            uuid primary key default gen_random_uuid(),
  key           text unique not null check (key in ('default_change_fund_php')),
  value_text    text,
  value_php     numeric(14,2),
  value_jsonb   jsonb,
  description   text,
  updated_at    timestamptz not null default now(),
  updated_by    uuid references public.staff_profiles(id)
);

create trigger trg_accounting_settings_updated_at
  before update on public.accounting_settings
  for each row execute function public.touch_updated_at();

alter table public.accounting_settings enable row level security;

create policy "accounting_settings: admin all"
  on public.accounting_settings
  for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

create policy "accounting_settings: staff read"
  on public.accounting_settings
  for select to authenticated
  using (public.has_role(array['reception','admin']));

insert into public.accounting_settings (key, value_php, description)
values (
  'default_change_fund_php',
  2000.00,
  'Baseline cash drawer float at start of each business date. Adjust via eod_cash_adjustments float_topup/float_pullout.'
)
on conflict (key) do nothing;

-- ---- CoA additions ---------------------------------------------------------
-- Idempotent: existing rows in production are unchanged; missing rows in a
-- fresh local DB get inserted.
insert into public.chart_of_accounts (code, name, type, normal_balance, description) values
  ('1130', 'Staff Advances',     'asset',   'debit', 'Outstanding cash advances to employees. Reduced by payroll deductions in 12.6.'),
  ('6320', 'Courier',            'expense', 'debit', 'Courier and delivery costs (specimen transport, document delivery, etc.).'),
  ('6900', 'Cash Short / Over',  'expense', 'debit', 'Net daily till variances. Negative balance is acceptable (net overs).')
on conflict (code) do nothing;

-- ---- cash_adjustment_account_map -------------------------------------------
-- Mirrors payment_method_account_map from 0030. Admin manages via
-- /staff/admin/accounting/cash-routing.
create table public.cash_adjustment_account_map (
  id                     uuid primary key default gen_random_uuid(),
  kind                   text unique not null check (kind in (
    'petty_cash', 'salary_advance', 'courier', 'other_payout',
    'float_topup', 'float_pullout'
  )),
  account_id             uuid not null references public.chart_of_accounts(id),
  requires_user_choice   boolean not null default false,
  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create trigger trg_cash_adjustment_account_map_updated_at
  before update on public.cash_adjustment_account_map
  for each row execute function public.touch_updated_at();

alter table public.cash_adjustment_account_map enable row level security;

create policy "cash_adjustment_account_map: admin read"
  on public.cash_adjustment_account_map
  for select to authenticated
  using (public.has_role(array['admin']));

create policy "cash_adjustment_account_map: admin write"
  on public.cash_adjustment_account_map
  for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

insert into public.cash_adjustment_account_map (kind, account_id, requires_user_choice, notes)
values
  ('petty_cash',     public.coa_uuid_for_code('6400'), true,  'Default for petty cash; reception picks a more specific expense account when adding the row.'),
  ('salary_advance', public.coa_uuid_for_code('1130'), false, 'Always 1130 in v1; not user-overridable.'),
  ('courier',        public.coa_uuid_for_code('6320'), false, 'Dedicated courier expense; fixed mapping.'),
  ('other_payout',   public.coa_uuid_for_code('9999'), true,  'Falls back to Suspense with audit if reception skips contra picker.'),
  ('float_topup',    public.coa_uuid_for_code('1020'), true,  'Source of the cash (bank withdrawal, owner cap, etc.). Default BPI.'),
  ('float_pullout',  public.coa_uuid_for_code('1020'), true,  'Destination of the cash (bank deposit, owner drawing). Default BPI.')
on conflict (kind) do nothing;

-- ---- eod_cash_adjustments --------------------------------------------------
create table public.eod_cash_adjustments (
  id                  uuid primary key default gen_random_uuid(),
  business_date       date not null,
  shift_id            uuid not null references public.cash_shifts(id),
  kind                text not null check (kind in (
    'petty_cash', 'salary_advance', 'courier', 'other_payout',
    'float_topup', 'float_pullout'
  )),
  amount_php          numeric(14,2) not null check (amount_php > 0),
  payee               text,
  payee_staff_id      uuid references public.staff_profiles(id),
  contra_account_id   uuid references public.chart_of_accounts(id),
  notes               text,
  recorded_by         uuid not null references public.staff_profiles(id),
  recorded_at         timestamptz not null default now(),
  voided_at           timestamptz,
  voided_by           uuid references public.staff_profiles(id),
  void_reason         text,
  constraint eod_cash_adjustments_salary_advance_has_staff
    check (kind != 'salary_advance' or payee_staff_id is not null),
  constraint eod_cash_adjustments_void_consistency
    check ((voided_at is null) = (voided_by is null))
);

create index idx_eod_cash_adjustments_date
  on public.eod_cash_adjustments (business_date, shift_id);

create index idx_eod_cash_adjustments_kind
  on public.eod_cash_adjustments (kind);

create index idx_eod_cash_adjustments_active
  on public.eod_cash_adjustments (business_date, shift_id)
  where voided_at is null;

create index idx_eod_cash_adjustments_staff
  on public.eod_cash_adjustments (payee_staff_id)
  where payee_staff_id is not null;

alter table public.eod_cash_adjustments enable row level security;

create policy "eod_cash_adjustments: staff read"
  on public.eod_cash_adjustments
  for select to authenticated
  using (public.has_role(array['reception','admin']));

create policy "eod_cash_adjustments: staff write"
  on public.eod_cash_adjustments
  for all to authenticated
  using (public.has_role(array['reception','admin']))
  with check (public.has_role(array['reception','admin']));

-- ---- eod_close_records -----------------------------------------------------
create table public.eod_close_records (
  id                    uuid primary key default gen_random_uuid(),
  business_date         date not null,
  shift_id              uuid not null references public.cash_shifts(id),
  status                text not null default 'closed'
                          check (status in ('closed', 'reopened')),
  opening_float_php     numeric(14,2) not null,
  cash_payments_php     numeric(14,2) not null,
  cash_payouts_php      numeric(14,2) not null,
  expected_cash_php     numeric(14,2) not null,
  counted_cash_php      numeric(14,2) not null check (counted_cash_php >= 0),
  variance_php          numeric(14,2) not null,
  variance_reason       text,
  closed_by             uuid not null references public.staff_profiles(id),
  closed_at             timestamptz not null default now(),
  reopened_by           uuid references public.staff_profiles(id),
  reopened_at           timestamptz,
  reopen_reason         text,
  created_at            timestamptz not null default now(),
  constraint eod_close_variance_matches
    check (variance_php = counted_cash_php - expected_cash_php),
  constraint eod_close_variance_reason_required
    check (variance_php = 0 or variance_reason is not null),
  constraint eod_close_reopen_reason_required
    check (status != 'reopened' or reopen_reason is not null)
);

-- One ACTIVE close per (business_date, shift_id). Reopened rows linger
-- for audit; a fresh re-close inserts a new row.
create unique index eod_close_records_one_active
  on public.eod_close_records (business_date, shift_id)
  where status = 'closed';

create index idx_eod_close_records_date
  on public.eod_close_records (business_date desc, shift_id);

alter table public.eod_close_records enable row level security;

create policy "eod_close_records: staff read"
  on public.eod_close_records
  for select to authenticated
  using (public.has_role(array['reception','admin']));

create policy "eod_close_records: staff insert"
  on public.eod_close_records
  for insert to authenticated
  with check (public.has_role(array['reception','admin']));

create policy "eod_close_records: admin update"
  on public.eod_close_records
  for update to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

-- ---- staff_advances --------------------------------------------------------
-- Receivable subledger maintained by the staff_advance_sync trigger.
-- Application code in 12.C never INSERTs here directly.
create table public.staff_advances (
  id                       uuid primary key default gen_random_uuid(),
  staff_id                 uuid not null references public.staff_profiles(id),
  source_adjustment_id     uuid unique not null references public.eod_cash_adjustments(id) on delete restrict,
  business_date            date not null,
  original_amount_php      numeric(14,2) not null check (original_amount_php > 0),
  outstanding_balance_php  numeric(14,2) not null check (outstanding_balance_php >= 0),
  status                   text not null default 'outstanding'
                             check (status in ('outstanding','settled','voided','written_off')),
  notes                    text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create trigger trg_staff_advances_updated_at
  before update on public.staff_advances
  for each row execute function public.touch_updated_at();

create index idx_staff_advances_staff_outstanding
  on public.staff_advances (staff_id)
  where status = 'outstanding';

alter table public.staff_advances enable row level security;

create policy "staff_advances: admin all"
  on public.staff_advances
  for all to authenticated
  using (public.has_role(array['admin']))
  with check (public.has_role(array['admin']));

create policy "staff_advances: reception read"
  on public.staff_advances
  for select to authenticated
  using (public.has_role(array['reception','admin']));

-- ---- Helper: resolve_cash_adjustment_account -------------------------------
-- Resolves the non-cash side of a cash-adjustment JE.
-- If contra_account_id is provided, use it. Otherwise look up the kind's
-- default from cash_adjustment_account_map. If the map requires user choice
-- and we got here without a chosen account, fall back to 9999 Suspense.
create or replace function public.resolve_cash_adjustment_account(
  p_kind               text,
  p_contra_account_id  uuid
)
returns table (account_id uuid, used_suspense boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_map_account uuid;
  v_requires    boolean;
begin
  if p_contra_account_id is not null then
    return query select p_contra_account_id, false;
    return;
  end if;

  select cam.account_id, cam.requires_user_choice
    into v_map_account, v_requires
    from public.cash_adjustment_account_map cam
    where cam.kind = p_kind;

  if v_map_account is null then
    return query select public.coa_uuid_for_code('9999'), true;
    return;
  end if;

  if v_requires then
    -- User-choice required but skipped → suspense fallback.
    return query select public.coa_uuid_for_code('9999'), true;
    return;
  end if;

  return query select v_map_account, false;
end;
$$;

-- ---- Bridge: cash adjustment INSERT -----------------------------------------
create or replace function public.bridge_cash_adjustment_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_je_id          uuid;
  v_existing_je    uuid;
  v_cash_id        uuid;
  v_contra_id      uuid;
  v_used_suspense  boolean;
  v_debit_acct     uuid;
  v_credit_acct    uuid;
begin
  -- Idempotency.
  select id into v_existing_je
    from public.journal_entries
    where source_kind = 'cash_adjustment'
      and source_id = NEW.id
      and status = 'posted'
    for update;
  if v_existing_je is not null then
    return NEW;
  end if;

  v_cash_id := public.coa_uuid_for_code('1010');

  select r.account_id, r.used_suspense
    into v_contra_id, v_used_suspense
    from public.resolve_cash_adjustment_account(NEW.kind, NEW.contra_account_id) r;

  -- Direction: float_topup is cash IN; everything else is cash OUT.
  if NEW.kind = 'float_topup' then
    v_debit_acct  := v_cash_id;
    v_credit_acct := v_contra_id;
  else
    v_debit_acct  := v_contra_id;
    v_credit_acct := v_cash_id;
  end if;

  insert into public.journal_entries (
    posting_date, description, status, source_kind, source_id, created_by
  )
  values (
    NEW.business_date,
    'Cash ' || NEW.kind || coalesce(' · ' || NEW.payee, ''),
    'draft',
    'cash_adjustment',
    NEW.id,
    NEW.recorded_by
  )
  returning id into v_je_id;

  insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
  values
    (v_je_id, v_debit_acct,  NEW.amount_php, 0, 1),
    (v_je_id, v_credit_acct, 0, NEW.amount_php, 2);

  update public.journal_entries set status = 'posted' where id = v_je_id;

  if v_used_suspense then
    insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
    values (
      NEW.recorded_by,
      'staff',
      'coa.suspense_post',
      'journal_entries',
      v_je_id,
      jsonb_build_object(
        'source_kind', 'cash_adjustment',
        'source_id',   NEW.id,
        'reason',      'cash adjustment kind required contra choice but received null',
        'kind',        NEW.kind
      )
    );
  end if;

  return NEW;
end;
$$;

create trigger trg_bridge_cash_adjustment_insert
  after insert on public.eod_cash_adjustments
  for each row execute function public.bridge_cash_adjustment_insert();

-- ---- Bridge: cash adjustment VOID ------------------------------------------
create or replace function public.bridge_cash_adjustment_void()
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
    where source_kind = 'cash_adjustment'
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
    NEW.voided_at::date,
    'Reversal of ' || v_orig_number || ': ' || coalesce(NEW.void_reason, '(no reason)'),
    'draft',
    'reversal',
    null,
    v_original_je,
    NEW.voided_by
  )
  returning id into v_reversal_je;

  insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
  select v_reversal_je, account_id, credit_php, debit_php, line_order
    from public.journal_lines
    where entry_id = v_original_je
    order by line_order;

  update public.journal_entries set status = 'posted' where id = v_reversal_je;

  update public.journal_entries
    set status = 'reversed',
        reversed_by = v_reversal_je
    where id = v_original_je;

  return NEW;
end;
$$;

create trigger trg_bridge_cash_adjustment_void
  after update on public.eod_cash_adjustments
  for each row
  when (OLD.voided_at is null and NEW.voided_at is not null)
  execute function public.bridge_cash_adjustment_void();

-- ---- Bridge: EOD close (variance JE) ---------------------------------------
create or replace function public.bridge_eod_close()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_je_id        uuid;
  v_cash_id      uuid;
  v_shortover_id uuid;
  v_abs_variance numeric(14,2);
begin
  if NEW.variance_php = 0 then
    return NEW;
  end if;

  v_cash_id      := public.coa_uuid_for_code('1010');
  v_shortover_id := public.coa_uuid_for_code('6900');
  v_abs_variance := abs(NEW.variance_php);

  insert into public.journal_entries (
    posting_date, description, status, source_kind, source_id, created_by
  )
  values (
    NEW.business_date,
    case
      when NEW.variance_php < 0 then 'Cash short ₱' || v_abs_variance
      else 'Cash over ₱' || v_abs_variance
    end || ' — ' || coalesce(NEW.variance_reason, '(no reason)'),
    'draft',
    'eod_close',
    NEW.id,
    NEW.closed_by
  )
  returning id into v_je_id;

  if NEW.variance_php < 0 then
    -- Short: counted less than expected. Write till down to actual.
    insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
    values
      (v_je_id, v_shortover_id, v_abs_variance, 0, 1),
      (v_je_id, v_cash_id,      0, v_abs_variance, 2);
  else
    -- Over: counted more than expected. Write till up.
    insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
    values
      (v_je_id, v_cash_id,      v_abs_variance, 0, 1),
      (v_je_id, v_shortover_id, 0, v_abs_variance, 2);
  end if;

  update public.journal_entries set status = 'posted' where id = v_je_id;

  return NEW;
end;
$$;

create trigger trg_bridge_eod_close
  after insert on public.eod_close_records
  for each row
  when (NEW.status = 'closed' and NEW.variance_php <> 0)
  execute function public.bridge_eod_close();

-- ---- staff_advance_sync ----------------------------------------------------
-- Mirrors salary_advance cash adjustments into the staff_advances receivable
-- subledger. INSERT creates the row; void zeros the balance.
create or replace function public.staff_advance_sync_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.kind != 'salary_advance' then
    return NEW;
  end if;

  insert into public.staff_advances (
    staff_id, source_adjustment_id, business_date,
    original_amount_php, outstanding_balance_php, status
  )
  values (
    NEW.payee_staff_id,
    NEW.id,
    NEW.business_date,
    NEW.amount_php,
    NEW.amount_php,
    'outstanding'
  )
  on conflict (source_adjustment_id) do nothing;

  return NEW;
end;
$$;

create or replace function public.staff_advance_sync_void()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.kind != 'salary_advance' then
    return NEW;
  end if;

  update public.staff_advances
    set outstanding_balance_php = 0,
        status = 'voided',
        updated_at = now()
    where source_adjustment_id = NEW.id;

  return NEW;
end;
$$;

create trigger trg_staff_advance_sync_insert
  after insert on public.eod_cash_adjustments
  for each row execute function public.staff_advance_sync_insert();

create trigger trg_staff_advance_sync_void
  after update on public.eod_cash_adjustments
  for each row
  when (OLD.voided_at is null and NEW.voided_at is not null)
  execute function public.staff_advance_sync_void();

-- ---- Guard P0015: EOD lock -------------------------------------------------
-- Blocks writes that would target a closed (business_date, shift_id).
-- v1: shift is the single active row in cash_shifts (payments has no shift_id).
create or replace function public.eod_lock_check(
  p_business_date date,
  p_shift_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_closed_at timestamptz;
  v_shift_code text;
begin
  select ec.closed_at into v_closed_at
    from public.eod_close_records ec
    where ec.business_date = p_business_date
      and ec.shift_id      = p_shift_id
      and ec.status        = 'closed'
    limit 1;

  if v_closed_at is null then
    return;
  end if;

  select code into v_shift_code from public.cash_shifts where id = p_shift_id;

  raise exception
    'EOD already closed for business_date % (shift %) at %. Ask an admin to reopen the close before recording further activity.',
    p_business_date, coalesce(v_shift_code, '?'), v_closed_at
    using errcode = 'P0015';
end;
$$;

create or replace function public.eod_cash_adjustments_block_after_close()
returns trigger
language plpgsql
as $$
begin
  perform public.eod_lock_check(NEW.business_date, NEW.shift_id);
  return NEW;
end;
$$;

create or replace function public.payments_block_after_close()
returns trigger
language plpgsql
as $$
declare
  v_date date;
  v_shift_id uuid;
begin
  v_date := (coalesce(NEW.received_at, OLD.received_at) at time zone 'Asia/Manila')::date;
  select id into v_shift_id
    from public.cash_shifts
    where is_active = true
    order by sort_order, code
    limit 1;
  if v_shift_id is null then
    return coalesce(NEW, OLD);
  end if;
  perform public.eod_lock_check(v_date, v_shift_id);
  return coalesce(NEW, OLD);
end;
$$;

create trigger trg_eod_cash_adjustments_block_after_close_iu
  before insert or update on public.eod_cash_adjustments
  for each row execute function public.eod_cash_adjustments_block_after_close();

create trigger trg_payments_block_after_close_iu
  before insert or update on public.payments
  for each row execute function public.payments_block_after_close();

-- ---- Guard P0017: cash adjustment immutable after JE -----------------------
create or replace function public.cash_adjustments_block_post_je_edits()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1 from public.journal_entries
    where source_kind = 'cash_adjustment'
      and source_id = NEW.id
      and status = 'posted'
  ) then
    if NEW.amount_php       is distinct from OLD.amount_php
       or NEW.kind          is distinct from OLD.kind
       or NEW.business_date is distinct from OLD.business_date
       or NEW.shift_id      is distinct from OLD.shift_id
       or NEW.payee_staff_id is distinct from OLD.payee_staff_id
       or NEW.contra_account_id is distinct from OLD.contra_account_id then
      raise exception
        'Cannot edit cash adjustment after JE has posted. Void and re-create instead.'
        using errcode = 'P0017';
    end if;
  end if;
  return NEW;
end;
$$;

create trigger trg_cash_adjustments_block_post_je_edits
  before update on public.eod_cash_adjustments
  for each row execute function public.cash_adjustments_block_post_je_edits();

-- ---- Guard P0018: staff_advance overdraw -----------------------------------
create or replace function public.staff_advances_block_overdraw()
returns trigger
language plpgsql
as $$
begin
  if NEW.outstanding_balance_php < 0 then
    raise exception
      'Staff advance cannot go below zero (would be %).', NEW.outstanding_balance_php
      using errcode = 'P0018';
  end if;
  return NEW;
end;
$$;

create trigger trg_staff_advances_block_overdraw
  before update on public.staff_advances
  for each row execute function public.staff_advances_block_overdraw();

-- ---- Guard P0019: cash_adjustment_account_map references inactive ---------
create or replace function public.cash_adjustment_account_map_block_inactive()
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
      'Account % is inactive and cannot be used as a cash-adjustment routing target.', v_code
      using errcode = 'P0019';
  end if;
  return NEW;
end;
$$;

create trigger trg_cash_adjustment_account_map_block_inactive
  before insert or update on public.cash_adjustment_account_map
  for each row execute function public.cash_adjustment_account_map_block_inactive();

-- ---- Views: admin reports --------------------------------------------------
create or replace view public.v_daily_revenue_by_service as
select
  (tr.released_at at time zone 'Asia/Manila')::date as business_date,
  s.id   as service_id,
  s.code as service_code,
  s.name as service_name,
  s.kind as service_kind,
  count(*)                                              as released_count,
  coalesce(sum(tr.final_price_php), 0)::numeric(14,2)   as revenue_php,
  coalesce(sum(tr.discount_amount_php), 0)::numeric(14,2) as discount_php
from public.test_requests tr
join public.services s on s.id = tr.service_id
where tr.status = 'released'
group by business_date, s.id, s.code, s.name, s.kind;

alter view public.v_daily_revenue_by_service owner to postgres;

create or replace view public.v_staff_advances_outstanding as
select
  sa.staff_id,
  sp.full_name,
  sp.role,
  count(*) filter (where sa.status = 'outstanding')                  as advance_count,
  coalesce(sum(sa.outstanding_balance_php), 0)::numeric(14,2)         as outstanding_php,
  min(sa.business_date) filter (where sa.status = 'outstanding')      as oldest_advance_date
from public.staff_advances sa
join public.staff_profiles sp on sp.id = sa.staff_id
group by sa.staff_id, sp.full_name, sp.role;

alter view public.v_staff_advances_outstanding owner to postgres;

-- ---- cash_drawer_state -----------------------------------------------------
create or replace function public.cash_drawer_state(
  p_business_date date,
  p_shift_id      uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with
    baseline as (
      select coalesce(value_php, 0)::numeric(14,2) as v
        from public.accounting_settings
        where key = 'default_change_fund_php'
    ),
    floats as (
      select
        coalesce(sum(case when kind = 'float_topup'   then amount_php else 0 end), 0)::numeric(14,2) as topups,
        coalesce(sum(case when kind = 'float_pullout' then amount_php else 0 end), 0)::numeric(14,2) as pullouts
      from public.eod_cash_adjustments
      where business_date = p_business_date
        and shift_id      = p_shift_id
        and voided_at is null
    ),
    cash_in as (
      select coalesce(sum(p.amount_php), 0)::numeric(14,2) as v
        from public.payments p
        where (p.received_at at time zone 'Asia/Manila')::date = p_business_date
          and p.method = 'cash'
          and p.voided_at is null
    ),
    cash_in_by_method as (
      select coalesce(jsonb_object_agg(p.method, total), '{}'::jsonb) as v
      from (
        select p.method, sum(p.amount_php)::numeric(14,2) as total
          from public.payments p
          where (p.received_at at time zone 'Asia/Manila')::date = p_business_date
            and p.voided_at is null
          group by p.method
      ) p
    ),
    payouts as (
      select coalesce(sum(amount_php), 0)::numeric(14,2) as v
        from public.eod_cash_adjustments
        where business_date = p_business_date
          and shift_id      = p_shift_id
          and kind in ('petty_cash','salary_advance','courier','other_payout')
          and voided_at is null
    ),
    closed as (
      select id, closed_at, closed_by, variance_php, variance_reason, counted_cash_php, expected_cash_php
        from public.eod_close_records
        where business_date = p_business_date
          and shift_id      = p_shift_id
          and status        = 'closed'
        limit 1
    )
  select jsonb_build_object(
    'business_date',      p_business_date,
    'shift_id',           p_shift_id,
    'baseline_float_php', baseline.v,
    'float_topups_php',   floats.topups,
    'float_pullouts_php', floats.pullouts,
    'opening_float_php',  (baseline.v + floats.topups - floats.pullouts),
    'cash_payments_php',  cash_in.v,
    'payments_by_method', cash_in_by_method.v,
    'cash_payouts_php',   payouts.v,
    'expected_cash_php',  (baseline.v + floats.topups - floats.pullouts + cash_in.v - payouts.v),
    'closed',             (select to_jsonb(c) from closed c)
  )
  from baseline, floats, cash_in, cash_in_by_method, payouts;
$$;

grant execute on function public.cash_drawer_state(date, uuid) to authenticated;
