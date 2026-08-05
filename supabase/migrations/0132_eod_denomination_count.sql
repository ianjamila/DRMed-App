-- =============================================================================
-- 0132_eod_denomination_count.sql
-- =============================================================================
-- PR N: record HOW the till was counted, not just the peso total.
--
-- Before this, /staff/payments/eod stored a single hand-typed
-- counted_cash_php. A short or over could not be traced to a pile ("we're one
-- ₱1000 short" vs "the coins were miscounted"), and the paper count sheet the
-- clinic keeps had no in-app counterpart.
--
-- After this migration:
--   * eod_close_records.counted_denominations holds the piece count per
--     denomination, and counted_cash_php is derived from it.
--   * A P0048 guard enforces breakdown-sum = counted_cash_php, so no writer —
--     app, script, or psql — can leave the two disagreeing.
--   * cash_drawer_state() surfaces the breakdown to the EOD page.
--
-- Nullable, NO backfill. Every close that predates this migration was counted
-- on paper; inventing a breakdown would fabricate audit data. NULL renders as
-- "not recorded" on every read surface, and the guard skips NULL entirely so
-- the admin reopen action can still UPDATE those legacy rows.
-- =============================================================================

-- ---- Column ----------------------------------------------------------------
alter table public.eod_close_records
  add column counted_denominations jsonb
  check (counted_denominations is null
         or jsonb_typeof(counted_denominations) = 'object');

comment on column public.eod_close_records.counted_denominations is
  'Piece count per denomination slug, e.g. {"bill_1000":3,"coin_0.25":8}. '
  'NULL for closes recorded before PR N (no backfill — the count was on paper). '
  'When present, must sum to counted_cash_php (guard P0048).';

-- ---- Helper: peso total of a breakdown -------------------------------------
-- CANONICAL DENOMINATION TABLE, COPY 1 OF 2.
-- The other copy is CASH_DENOMINATIONS in
-- src/lib/accounting/cash-denominations.ts. Both must list the same 11 slugs
-- with the same peso values; the app derives counted_cash_php from the TS copy
-- and this function re-checks it in the guard below, so a drift between them
-- would make every close fail P0048.
--
-- The ₱20 bill and the ₱20 coin are separate slugs on purpose — two physical
-- piles, counted separately. 5- and 1-sentimo are omitted (out of circulation).
--
-- numeric is exact, so this sums directly; the TS copy has to work in centavos
-- to keep ₱0.25 × n out of floating-point drift.
create or replace function public.cash_denomination_total_php(p jsonb)
returns numeric(14,2)
language sql
immutable
set search_path = public
as $$
  select coalesce(sum(
    coalesce((p ->> d.slug)::numeric, 0) * d.value_php
  ), 0)::numeric(14,2)
  from (values
    ('bill_1000', 1000::numeric),
    ('bill_500',   500::numeric),
    ('bill_200',   200::numeric),
    ('bill_100',   100::numeric),
    ('bill_50',     50::numeric),
    ('bill_20',     20::numeric),
    ('coin_20',     20::numeric),
    ('coin_10',     10::numeric),
    ('coin_5',       5::numeric),
    ('coin_1',       1::numeric),
    ('coin_0.25', 0.25::numeric)
  ) as d(slug, value_php);
$$;

comment on function public.cash_denomination_total_php(jsonb) is
  'Peso value of an EOD denomination breakdown. Mirror of CASH_DENOMINATIONS in '
  'src/lib/accounting/cash-denominations.ts — keep both copies in step.';

-- No grant beyond the 0119 default (postgres + service_role). This function is
-- only ever reached from the trigger below and from the service-role admin
-- client; nothing in the browser or a staff JWT calls it.

-- ---- Guard P0048: breakdown must be well-formed and tie to the total -------
-- House style from 0043 (P0015/P0017/P0018/P0019): a BEFORE trigger that
-- RAISEs, so translatePgError has a readable message to pass through.
create or replace function public.eod_close_denominations_check()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_key    text;
  v_value  jsonb;
  v_total  numeric(14,2);
  v_slugs  text[] := array[
    'bill_1000','bill_500','bill_200','bill_100','bill_50','bill_20',
    'coin_20','coin_10','coin_5','coin_1','coin_0.25'
  ];
begin
  -- Legacy rows carry no breakdown. Skipping NULL is load-bearing: the admin
  -- reopen action UPDATEs pre-PR-N closes, and without this every reopen of an
  -- old day would raise.
  if NEW.counted_denominations is null then
    return NEW;
  end if;

  -- The column CHECK also rejects non-objects, but a BEFORE trigger runs first
  -- and jsonb_each would blow up on an array with a raw "cannot call jsonb_each
  -- on a non-object" (SQLSTATE 22023) that translatePgError has no case for.
  -- Claim the case here so it surfaces as a readable P0048 like the rest.
  if jsonb_typeof(NEW.counted_denominations) <> 'object' then
    raise exception
      'The denomination count must be an object keyed by denomination (got %).',
      jsonb_typeof(NEW.counted_denominations)
      using errcode = 'P0048';
  end if;

  for v_key, v_value in select * from jsonb_each(NEW.counted_denominations) loop
    if not (v_key = any(v_slugs)) then
      raise exception
        'Unknown cash denomination "%". Expected one of: %.', v_key, array_to_string(v_slugs, ', ')
        using errcode = 'P0048';
    end if;

    if jsonb_typeof(v_value) <> 'number'
       or (v_value::text)::numeric < 0
       or (v_value::text)::numeric <> trunc((v_value::text)::numeric) then
      raise exception
        'Denomination "%" must be a whole number of pieces, zero or more (got %).', v_key, v_value::text
        using errcode = 'P0048';
    end if;
  end loop;

  v_total := public.cash_denomination_total_php(NEW.counted_denominations);
  if v_total <> NEW.counted_cash_php then
    raise exception
      'Denomination counts total ₱% but the counted cash is ₱%. The two must match.',
      v_total, NEW.counted_cash_php
      using errcode = 'P0048';
  end if;

  return NEW;
end;
$$;

create trigger trg_eod_close_denominations_check
  before insert or update on public.eod_close_records
  for each row execute function public.eod_close_denominations_check();

-- ---- cash_drawer_state: surface the breakdown ------------------------------
-- Re-created verbatim from 0043 with ONE change: the `closed` CTE selects an
-- explicit column list, so counted_denominations has to be added there or the
-- EOD page would never see it. `create or replace` keeps the existing
-- `authenticated` grant.
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
      select id, closed_at, closed_by, variance_php, variance_reason,
             counted_cash_php, expected_cash_php, counted_denominations
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

-- Restate the post-0118 ACL rather than 0043's original `grant … to
-- authenticated`. `create or replace` preserves whatever ACL the function
-- currently carries, and 0118 deliberately revoked anon/authenticated from this
-- SECURITY DEFINER function (it reads every payment for a date, bypassing RLS)
-- and left it service-role-only. Re-granting authenticated here would silently
-- reopen that hole. These two statements are idempotent and keep the intended
-- state greppable at the point the function is defined.
revoke execute on function public.cash_drawer_state(date, uuid) from public, anon, authenticated;
grant  execute on function public.cash_drawer_state(date, uuid) to service_role;
