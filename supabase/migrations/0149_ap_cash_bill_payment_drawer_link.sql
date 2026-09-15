-- =============================================================================
-- 0149_ap_cash_bill_payment_drawer_link.sql
-- =============================================================================
-- The THIRD cash door (SectionTabs audit, flagged when M1 shipped as 0145).
--
-- 0145 made this the rule: cash cannot leave the till without the drawer
-- knowing. `cash_drawer_state.expected_cash_php` derives the day's payouts
-- SOLELY from `eod_cash_adjustments` — it never reads `journal_entries` — so
-- anything that credits 1010 Cash on Hand without writing that table moves the
-- books and not the drawer. Reception then counts short, and the EOD close
-- (0043 `bridge_eod_close`) credits cash a SECOND time into 6900 Cash
-- Short/Over. One outflow, cash credited twice.
--
-- 0145 closed the two doors it was scoped to (the Petty cash page and admin
-- Quick expense) and named this one as still open: paying a supplier bill in
-- cash. `ap_bill_payment_bridge` (0049) posts DR 2100 AP — Trade / CR
-- `cash_account_id`, and when that account is 1010 the till just lost money
-- that no drawer view has ever heard about. The payment also walked straight
-- past the day-close lock (P0015), which only guards `eod_cash_adjustments`
-- and `payments`.
--
-- PROD STATE, re-measured 2026-09-15 immediately before shipping: all 75
-- `bill_payments` rows are method='cash' against 1010, ₱418,319 in total,
-- payment dates 2026-01-03 to 2026-05-26, every one created 2026-05-28 as a
-- single history-import batch — and ALL 75 ARE NOW VOIDED. Nothing live has
-- ever gone through this path. No `eod_close_records` row covers any of those
-- dates either (the EOD close has never been run for them), so no day carries
-- a posted shortage from this defect and there is NOTHING TO BACKFILL —
-- writing drawer rows for a closed, un-counted history would invent payouts
-- against days nobody ever counted. The flow is live, though, and cash is the
-- only method anyone has ever used on it.
--
-- ---- SHAPE ------------------------------------------------------------------
--
-- Copy the gift-code precedent (0139): a nullable FK plus a biconditional
-- CHECK tying it to exactly one `kind`. `gift_code_sale`/`gift_code_id` is the
-- model; this adds `bill_payment`/`bill_payment_id`.
--
-- Two deliberate departures from that precedent, both forced by the fact that
-- the AP subledger already owns this money movement:
--
--   1. THE DRAWER ROW POSTS NO JOURNAL ENTRY. `ap_bill_payment_bridge` already
--      posts DR 2100 / CR 1010 with source_kind='bill_payment'. If
--      `bridge_cash_adjustment_insert` also fired, 1010 would be credited
--      twice — precisely the double-credit 0145 existed to stop. So the
--      insert bridge early-returns for this kind and the row is drawer-only:
--      its whole job is to make `cash_drawer_state` see the outflow.
--      `bridge_cash_adjustment_void` needs no change — it already returns
--      early when no posted `cash_adjustment` JE exists for the row.
--      Consequently there is no `cash_adjustment_account_map` entry and no
--      `contra_account_id`: nothing resolves one.
--
--   2. THE AP PAYMENT OWNS THE ROW. Voiding the drawer row on its own would
--      hand the cash back to the till while the books still say the supplier
--      was paid. P0052 blocks that (and any edit of the linked row's money
--      fields); the void arrives by mirror from `bill_payments.voided_at`
--      instead, so the one control — void the AP payment — moves both. This
--      is the same reasoning that made the drawer suppress its generic Void
--      button for `gift_code_sale` (go-live finding 8).
--
-- ---- WHY A TRIGGER, NOT THE RPC --------------------------------------------
--
-- The audit said "post it inside `ap_create_bill_payment_with_allocations`".
-- That would have missed a live second door: the "Mark as paid" checkbox on
-- the new-bill form calls `ap_create_bill_paid_on_entry`, which inserts into
-- `bill_payments` directly (0049 line ~760). Those are the only two inserts
-- into that table in the whole schema. Hanging this off an AFTER INSERT
-- trigger — a sibling of `trg_bill_payment_bridge`, which is how the JE is
-- already posted — covers both and anything added later, at the one level
-- that cannot be bypassed.
--
-- ---- THE TEST IS THE ACCOUNT, NOT THE METHOD --------------------------------
--
-- The trigger fires on `cash_account_id = 1010`, not on `method = 'cash'`.
-- The invariant is about the till, and the till IS account 1010: the drawer
-- has to know about every credit to it, however the row labels its method
-- (`method='gcash'` against 1010 is a data-entry slip, but the peso still
-- leaves the drawer). Conversely a `method='cash'` payment posted against 1020
-- BPI never touched the till and must not produce a drawer row. On prod today
-- the two tests select the same 75 rows.
--
-- ---- BEHAVIOUR CHANGE THE BOOKKEEPER WILL SEE -------------------------------
--
-- `trg_eod_cash_adjustments_block_after_close_iu` now applies to AP cash bill
-- payments, because the drawer row is written in the same transaction. That
-- lock fires on INSERT **and** UPDATE, so it catches both AP writes:
--
--   CREATE — a cash bill payment dated into an already-closed (business_date,
--   shift) is refused with P0015 and the whole payment rolls back.
--
--   VOID — the void mirror below UPDATEs that same drawer row, so voiding a
--   cash payment whose day has since been closed is refused too, and the whole
--   `ap_void_bill_payment_cascade` transaction (reversal JE included) rolls
--   back. This is the COMMON case, not an edge one: a void almost always
--   happens after the payment's own business day has been counted.
--
-- Both are correct — a closed day has been counted and its variance posted, so
-- changing what left the till on it would falsify a count that has already been
-- signed off, and the petty-cash sibling (`voidTillCashExpense`) has behaved
-- this way since 0043. But both are new here, which is why the app layer gives
-- P0015 create- and void-specific messages, the two payment forms warn about a
-- closed date before submit, and the payment detail page disables Void with the
-- reason on screen. The escape hatch is the existing one: an admin reopens the
-- close.
-- =============================================================================

-- ---- Schema: the link column, the kind, the biconditional -------------------
alter table public.eod_cash_adjustments
  add column if not exists bill_payment_id uuid references public.bill_payments(id);

alter table public.eod_cash_adjustments
  drop constraint eod_cash_adjustments_kind_check;
alter table public.eod_cash_adjustments
  add constraint eod_cash_adjustments_kind_check check (kind in (
    'petty_cash','salary_advance','courier','other_payout','float_topup',
    'float_pullout','salary_payout','gift_code_sale','bill_payment'
  ));

-- The gift-code shape: the link and the kind imply each other, in both
-- directions, so neither a bare `bill_payment` row nor a link hidden under
-- some other kind can exist.
alter table public.eod_cash_adjustments
  add constraint eod_cash_adjustments_bill_payment_has_link
  check ((kind = 'bill_payment') = (bill_payment_id is not null));

-- One ACTIVE drawer row per AP payment. A voided one frees the slot, which
-- matters because voiding is the only way back out: it stops a second live row
-- from double-counting the same outflow if the mirror ever ran twice.
create unique index eod_cash_adjustments_bill_payment_active_unique
  on public.eod_cash_adjustments (bill_payment_id)
  where bill_payment_id is not null and voided_at is null;

create index idx_eod_cash_adjustments_bill_payment
  on public.eod_cash_adjustments (bill_payment_id)
  where bill_payment_id is not null;

-- ---- bridge_cash_adjustment_insert: bill_payment posts no JE ----------------
-- Byte-identical to 0139's body except for the early return below. CREATE OR
-- REPLACE keeps 0118's revoke in force; restated after the body for a
-- self-describing replay, per the drmed-migrations skill.
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
  -- 0149: the AP subledger already posted DR 2100 / CR 1010 for this outflow
  -- (ap_bill_payment_bridge, source_kind='bill_payment'). Posting again here
  -- would credit 1010 twice. The row exists only so cash_drawer_state sees the
  -- payout; its GL life belongs to the bill_payment, including the reversal
  -- ap_void_bill_payment_cascade posts on void.
  if NEW.kind = 'bill_payment' then
    return NEW;
  end if;

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

  -- Direction: float_topup and gift_code_sale are cash IN; everything else is
  -- cash OUT (0139 added gift_code_sale — a gift-code sale collects cash over
  -- the counter, same drawer direction as a float top-up).
  if NEW.kind in ('float_topup', 'gift_code_sale') then
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

revoke execute on function public.bridge_cash_adjustment_insert() from public, anon, authenticated;
grant  execute on function public.bridge_cash_adjustment_insert() to service_role;

-- ---- The link trigger: every credit to 1010 reaches the drawer --------------
-- P0051 covers the two ways the drawer row cannot be built at all. Both are
-- configuration faults, not data-entry ones, and both are better as a named
-- refusal than as the raw not-null violation the insert would otherwise throw:
-- letting the payment through without the row is the one outcome that must
-- never happen, because it is the bug itself.
create or replace function public.ap_bill_payment_drawer_link()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_shift_id     uuid;
  v_vendor_name  text;
  v_recorded_by  uuid;
begin
  if NEW.cash_account_id is distinct from public.coa_uuid_for_code('1010') then
    return NEW;
  end if;

  -- The same rule every shift-less table uses (payments_block_after_close,
  -- the cash drawer page, postTillCashExpense): first active shift by sort.
  select id into v_shift_id
    from public.cash_shifts
    where is_active = true
    order by sort_order, code
    limit 1;

  if v_shift_id is null then
    raise exception
      'No active cash shift is configured, so this cash payment cannot be recorded against the cash drawer. Ask an admin to set one up.'
      using errcode = 'P0051';
  end if;

  -- eod_cash_adjustments.recorded_by is not null and references
  -- staff_profiles(id) — the same id space as auth.users, so an admin actor
  -- resolves directly. Anything else (a payment inserted with no created_by,
  -- or by a non-staff user) has no honest value to record.
  select sp.id into v_recorded_by
    from public.staff_profiles sp
    where sp.id = NEW.created_by;

  if v_recorded_by is null then
    raise exception
      'This cash payment has no recording staff member, so it cannot be recorded against the cash drawer.'
      using errcode = 'P0051';
  end if;

  select name into v_vendor_name from public.vendors where id = NEW.vendor_id;

  -- business_date is the PAYMENT date, never today: the drawer and the GL have
  -- to agree about which day the cash left. This is what puts the payment
  -- under the day-close lock (P0015) via
  -- trg_eod_cash_adjustments_block_after_close_iu.
  insert into public.eod_cash_adjustments (
    business_date, shift_id, kind, amount_php, payee, notes,
    bill_payment_id, recorded_by
  )
  values (
    NEW.payment_date,
    v_shift_id,
    'bill_payment',
    NEW.amount_php,
    left(coalesce(v_vendor_name, 'Supplier'), 120),
    left(format('AP payment %s', NEW.payment_number), 500),
    NEW.id,
    v_recorded_by
  );

  return NEW;
end;
$$;

revoke execute on function public.ap_bill_payment_drawer_link() from public, anon, authenticated;
grant  execute on function public.ap_bill_payment_drawer_link() to service_role;

create trigger trg_bill_payment_drawer_link
  after insert on public.bill_payments
  for each row execute function public.ap_bill_payment_drawer_link();

-- ---- Void mirror: the AP payment's void carries the drawer row with it ------
create or replace function public.ap_bill_payment_drawer_void_mirror()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.eod_cash_adjustments a
     set voided_at   = NEW.voided_at,
         -- eod_cash_adjustments_void_consistency requires voided_by whenever
         -- voided_at is set, and it is an FK to staff_profiles. The cascade
         -- RPC always passes an admin actor; fall back to whoever recorded the
         -- row rather than fail a legitimate void on a missing id.
         voided_by   = coalesce(
                         (select sp.id from public.staff_profiles sp where sp.id = NEW.voided_by),
                         a.recorded_by
                       ),
         void_reason = NEW.void_reason
   where a.bill_payment_id = NEW.id
     and a.voided_at is null;

  return NEW;
end;
$$;

revoke execute on function public.ap_bill_payment_drawer_void_mirror() from public, anon, authenticated;
grant  execute on function public.ap_bill_payment_drawer_void_mirror() to service_role;

create trigger trg_bill_payment_drawer_void_mirror
  after update of voided_at on public.bill_payments
  for each row
  when (old.voided_at is null and new.voided_at is not null)
  execute function public.ap_bill_payment_drawer_void_mirror();

-- ---- Guard P0052: the AP payment owns the drawer row ------------------------
-- P0017 (cash adjustment immutable after JE) is inert for this kind, because
-- it keys on a posted source_kind='cash_adjustment' JE and these rows have
-- none. Without this guard the drawer's generic Void — and any direct UPDATE —
-- would hand the cash back to the till while the books still record the
-- supplier as paid.
--
-- The mirror above is allowed through because by the time it runs the parent
-- `bill_payments.voided_at` is already set, which is exactly the condition
-- this guard tests.
create or replace function public.eod_cash_adjustments_bill_payment_owned()
returns trigger
language plpgsql
as $$
declare
  v_parent_voided timestamptz;
begin
  if OLD.kind is distinct from 'bill_payment' and NEW.kind is distinct from 'bill_payment' then
    return NEW;
  end if;

  if NEW.bill_payment_id  is distinct from OLD.bill_payment_id
     or NEW.kind          is distinct from OLD.kind
     or NEW.amount_php    is distinct from OLD.amount_php
     or NEW.business_date is distinct from OLD.business_date
     or NEW.shift_id      is distinct from OLD.shift_id then
    raise exception
      'This cash drawer entry belongs to an AP bill payment and can only be changed on the payment itself.'
      using errcode = 'P0052';
  end if;

  -- Un-voiding is never allowed: the reversal JE the AP cascade posted stands.
  if OLD.voided_at is not null and NEW.voided_at is null then
    raise exception
      'This cash drawer entry belongs to an AP bill payment and cannot be un-voided. Record a new payment instead.'
      using errcode = 'P0052';
  end if;

  if OLD.voided_at is null and NEW.voided_at is not null then
    select bp.voided_at into v_parent_voided
      from public.bill_payments bp
      where bp.id = OLD.bill_payment_id;

    if v_parent_voided is null then
      raise exception
        'This cash drawer entry belongs to an AP bill payment. Void the payment itself (Admin → Expenses → Bill payments) so the books and the drawer come back together.'
        using errcode = 'P0052';
    end if;
  end if;

  return NEW;
end;
$$;

revoke execute on function public.eod_cash_adjustments_bill_payment_owned() from public, anon, authenticated;

create trigger trg_eod_cash_adjustments_bill_payment_owned
  before update on public.eod_cash_adjustments
  for each row execute function public.eod_cash_adjustments_bill_payment_owned();

-- ---- cash_drawer_state: count the new kind as a payout ----------------------
-- Re-created from 0139's body (the latest). One change: the `payouts` CTE also
-- matches kind='bill_payment'. Without this line the whole migration is inert —
-- the row would exist and `expected_cash_php` would still ignore it.
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
    gift_sales as (
      select coalesce(sum(amount_php), 0)::numeric(14,2) as v
        from public.eod_cash_adjustments
        where business_date = p_business_date
          and shift_id      = p_shift_id
          and kind          = 'gift_code_sale'
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
          and kind in ('petty_cash','salary_advance','courier','other_payout','salary_payout','bill_payment')
          and voided_at is null
    ),
    bill_payouts as (
      select coalesce(sum(amount_php), 0)::numeric(14,2) as v
        from public.eod_cash_adjustments
        where business_date = p_business_date
          and shift_id      = p_shift_id
          and kind          = 'bill_payment'
          and voided_at is null
    ),
    closed as (
      select id, closed_at, closed_by, variance_php, variance_reason,
             counted_cash_php, expected_cash_php, counted_denominations
        from public.eod_close_records
        where business_date = p_business_date
          and shift_id      = p_shift_id
          and status        = 'closed'
        limit 1
    )
  select jsonb_build_object(
    'business_date',        p_business_date,
    'shift_id',             p_shift_id,
    'baseline_float_php',   baseline.v,
    'float_topups_php',     floats.topups,
    'float_pullouts_php',   floats.pullouts,
    'opening_float_php',    (baseline.v + floats.topups - floats.pullouts),
    'cash_payments_php',    cash_in.v,
    'gift_code_sales_php',  gift_sales.v,
    'payments_by_method',   cash_in_by_method.v,
    'cash_payouts_php',     payouts.v,
    'bill_payments_php',    bill_payouts.v,
    'expected_cash_php',    (baseline.v + floats.topups - floats.pullouts + cash_in.v + gift_sales.v - payouts.v),
    'closed',               (select to_jsonb(c) from closed c)
  )
  from baseline, floats, gift_sales, cash_in, cash_in_by_method, payouts, bill_payouts;
$$;

revoke execute on function public.cash_drawer_state(date, uuid) from public, anon, authenticated;
grant  execute on function public.cash_drawer_state(date, uuid) to service_role;

-- ---- Post-conditions --------------------------------------------------------
do $$
declare
  v_src text;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'eod_cash_adjustments'
      and column_name = 'bill_payment_id'
  ) then
    raise exception '0149: eod_cash_adjustments.bill_payment_id is missing';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'eod_cash_adjustments_bill_payment_has_link'
      and conrelid = 'public.eod_cash_adjustments'::regclass
  ) then
    raise exception '0149: the bill_payment biconditional CHECK is missing';
  end if;

  -- The kind CHECK is stored as `= ANY (ARRAY[...])`, so match the value, not
  -- the `in (...)` text we wrote (the 0139 lesson).
  if not exists (
    select 1 from pg_constraint
    where conname = 'eod_cash_adjustments_kind_check'
      and conrelid = 'public.eod_cash_adjustments'::regclass
      and pg_get_constraintdef(oid) like '%bill_payment%'
  ) then
    raise exception '0149: eod_cash_adjustments_kind_check does not admit bill_payment';
  end if;

  foreach v_src in array array[
    'trg_bill_payment_drawer_link',
    'trg_bill_payment_drawer_void_mirror'
  ]
  loop
    if not exists (
      select 1 from pg_trigger
      where tgname = v_src and tgrelid = 'public.bill_payments'::regclass
    ) then
      raise exception '0149: trigger % is missing on bill_payments', v_src;
    end if;
  end loop;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_eod_cash_adjustments_bill_payment_owned'
      and tgrelid = 'public.eod_cash_adjustments'::regclass
  ) then
    raise exception '0149: the P0052 ownership guard is missing';
  end if;

  -- The whole migration is inert without this line, and it is the one change
  -- that lives inside a re-created function body rather than in DDL.
  if position('bill_payment' in pg_get_functiondef(
       'public.cash_drawer_state(date, uuid)'::regprocedure)) = 0 then
    raise exception '0149: cash_drawer_state does not count bill_payment as a payout';
  end if;

  if position('bill_payment' in pg_get_functiondef(
       'public.bridge_cash_adjustment_insert()'::regprocedure)) = 0 then
    raise exception '0149: bridge_cash_adjustment_insert lacks the bill_payment early return';
  end if;

  -- 1010 has to resolve, or the link trigger silently never fires.
  if public.coa_uuid_for_code('1010') is null then
    raise exception '0149: chart_of_accounts has no 1010 Cash on Hand';
  end if;
end;
$$;
