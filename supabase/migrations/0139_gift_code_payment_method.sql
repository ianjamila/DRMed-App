-- =============================================================================
-- 0139_gift_code_payment_method.sql
-- =============================================================================
-- N13 (go-live blocker) — redeeming a gift code ALWAYS fails on production.
-- src/app/(staff)/staff/(dashboard)/payments/new/actions.ts inserts a payment
-- with method: 'gift_code' when a code is redeemed against a visit, but the
-- live payments_method_check constraint (last (re)defined in 0011) only
-- allows cash/gcash/maya/card/bank_transfer/hmo/bpi/maybank. No gift-code
-- redemption has ever succeeded (0 rows on prod). Owner decision: gift codes
-- stay on sale, so this widens the constraint the same way 0011 widened it
-- (drop-by-generated-name, re-add — matching definition text against
-- `in (...)` silently no-ops because Postgres stores it as `= ANY (ARRAY[...])`).
--
-- N14 (medium) — selling a gift code for cash makes the EOD drawer look OVER.
-- src/app/(staff)/staff/(dashboard)/gift-codes/actions.ts (sellGiftCodeAction)
-- takes real cash over the counter but writes no `payments` row (0014 removed
-- payments.visit_id's nullability on purpose — a gift-code sale isn't tied to
-- a visit), so cash_drawer_state()'s `cash_in` CTE (sums payments.method='cash'
-- for the day) never sees it and EOD's expected_cash_php excludes real cash
-- that is sitting in the drawer. Fix: reuse `eod_cash_adjustments` — the
-- table that already exists specifically for cash movements that aren't tied
-- to a payments row (float top-ups, petty cash, salary advances) — with a new
-- kind, 'gift_code_sale', treated as cash IN exactly like float_topup. This is
-- "the route that already exists": no new ledger, no new drawer-facing concept.
--
-- Full accounting (see report for the narrative):
--   SALE (cash):        DR 1010 Cash                  CR 2250 Gift Codes Outstanding
--   REDEMPTION:         DR 2250 Gift Codes Outstanding CR 1100/1110 AR (via the
--                        existing bridge_payment_insert + a new
--                        payment_method_account_map row for 'gift_code' — no
--                        code change needed there, it already resolves by method)
--   RELEASE:             DR 1100/1110 AR               CR revenue   (unaffected)
-- The SALE JE and the REDEMPTION JE net account 2250 back to zero for a code
-- that is sold for cash and later redeemed. The drawer counts the cash exactly
-- once (at sale, via eod_cash_adjustments) — redemption's payments row has
-- method='gift_code', which cash_drawer_state()'s cash_in CTE does NOT match
-- (it filters method='cash' only), so the same peso is never counted twice.
--
-- Also fixes, while this function is already being re-created: the `payouts`
-- CTE in cash_drawer_state() omits kind='salary_payout' (added by 0044,
-- "Per-employee cash payout from /cash-drawer on payroll pay date" — a real
-- drawer outflow the EOD figure was silently not subtracting). Folded in here
-- rather than shipped as a second near-identical migration.
-- =============================================================================

-- ---- N13: widen payments_method_check --------------------------------------
alter table public.payments drop constraint payments_method_check;
alter table public.payments
  add constraint payments_method_check
  check (method in (
    'cash', 'gcash', 'maya', 'card', 'bank_transfer',
    'hmo', 'bpi', 'maybank', 'gift_code'
  ));

-- ---- N13 sibling fix: route the redemption JE's debit correctly -----------
-- resolve_cash_account(method) (0030) already falls back to 9999 Suspense for
-- any unmapped method, so redemption would have "worked" without this row —
-- but every redemption would misleadingly post to Suspense forever. Give it a
-- real home: a liability for cash collected at sale but not yet earned.
insert into public.chart_of_accounts (code, name, type, normal_balance, description)
values (
  '2250',
  'Gift Codes Outstanding',
  'liability',
  'credit',
  'Cash collected for gift codes sold but not yet redeemed. Credited at sale (via eod_cash_adjustments kind=gift_code_sale), debited at redemption (via the payments row, method=gift_code) — nets to zero across the life of a cash-sold code.'
)
on conflict (code) do nothing;

insert into public.payment_method_account_map (payment_method, account_id, notes)
values (
  'gift_code',
  public.coa_uuid_for_code('2250'),
  'Redemption debits the liability created at sale rather than fabricating new cash — see 0139.'
)
on conflict (payment_method) do nothing;

-- ---- Finding 6 (go-live review, blocker): redemption double-spend race ----
-- redeemGiftCode() (payments/new/actions.ts) reads a code as 'purchased',
-- inserts a `payments` row, THEN conditionally flips gift_codes to
-- 'redeemed' with `.eq('status','purchased')`. Two concurrent redemptions of
-- the SAME code can both pass the initial read and both insert a payment —
-- only the conditional UPDATE is atomic, and the app was only checking its
-- `error` (never null on a zero-row match), not whether it actually touched
-- a row. This unique index is the database-side guarantee: a code can have
-- at most one non-voided `gift_code` payment at a time, using the value
-- `reference_number` already carries on every redemption (the code itself).
-- The losing concurrent INSERT now fails outright with 23505 (translated to
-- a friendly message below) instead of silently minting a second payment;
-- the app also now checks the conditional UPDATE's row count as defence in
-- depth (e.g. the code got cancelled between the read and the write, a
-- window this index alone doesn't cover). Voiding a redemption sets
-- `voided_at`, which drops the row out of this partial index, freeing the
-- code to be redeemed again — matching voidPaymentAction resetting
-- gift_codes.status back to 'purchased'. Mirrors
-- eod_cash_adjustments_gift_code_active_unique (N14 above), which protects
-- the sale leg the same way.
create unique index payments_gift_code_redemption_unique
  on public.payments (reference_number)
  where method = 'gift_code' and voided_at is null;

-- ---- N14: eod_cash_adjustments — new kind + gift_code_id link --------------
alter table public.eod_cash_adjustments
  add column if not exists gift_code_id uuid references public.gift_codes(id);

alter table public.eod_cash_adjustments
  drop constraint eod_cash_adjustments_kind_check;
alter table public.eod_cash_adjustments
  add constraint eod_cash_adjustments_kind_check check (kind in (
    'petty_cash','salary_advance','courier','other_payout','float_topup',
    'float_pullout','salary_payout','gift_code_sale'
  ));

alter table public.eod_cash_adjustments
  add constraint eod_cash_adjustments_gift_code_sale_has_code
  check ((kind = 'gift_code_sale') = (gift_code_id is not null));

-- A code can only have one ACTIVE sale-adjustment row at a time. A voided one
-- (sale cancelled — see admin/gift-codes cancelGiftCodeAction) frees the slot
-- so a code could in principle be re-sold after a cancel-and-restart, though
-- today's flow doesn't offer that; the index just stops two live rows from
-- double-crediting the same code.
create unique index eod_cash_adjustments_gift_code_active_unique
  on public.eod_cash_adjustments (gift_code_id)
  where gift_code_id is not null and voided_at is null;

create index idx_eod_cash_adjustments_gift_code
  on public.eod_cash_adjustments (gift_code_id)
  where gift_code_id is not null;

alter table public.cash_adjustment_account_map
  drop constraint cash_adjustment_account_map_kind_check;
alter table public.cash_adjustment_account_map
  add constraint cash_adjustment_account_map_kind_check check (kind in (
    'petty_cash','salary_advance','courier','other_payout','float_topup',
    'float_pullout','salary_payout','gift_code_sale'
  ));

insert into public.cash_adjustment_account_map (kind, account_id, requires_user_choice, notes)
values (
  'gift_code_sale',
  public.coa_uuid_for_code('2250'),
  false,
  'Cash collected at gift-code sale; same liability the redemption payment later debits. Fixed mapping, not user-overridable.'
)
on conflict (kind) do nothing;

-- ---- N14: bridge_cash_adjustment_insert — gift_code_sale is cash IN -------
-- Byte-identical to 0043's body except the direction condition now also
-- matches 'gift_code_sale' (a sale is cash coming INTO the drawer, same as a
-- float top-up). CREATE OR REPLACE keeps 0118's revoke from public/anon/
-- authenticated in force; restated explicitly below for a self-describing replay.
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

-- ---- N14: cash_drawer_state — surface gift-code sales, fix salary_payout --
-- Re-created from 0132's body (the latest). Two changes:
--   1. New `gift_sales` CTE + `gift_code_sales_php` field, folded into
--      expected_cash_php so a cash gift-code sale stops looking like an
--      overage at close.
--   2. `payouts` CTE now also matches kind='salary_payout' (0044 added this
--      kind for per-employee cash payroll payouts from /cash-drawer; it was
--      never added to this sum, so a cash salary payout on close day silently
--      inflated expected_cash_php — the opposite-direction sibling of N14).
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
          and kind in ('petty_cash','salary_advance','courier','other_payout','salary_payout')
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
    'business_date',       p_business_date,
    'shift_id',            p_shift_id,
    'baseline_float_php',  baseline.v,
    'float_topups_php',    floats.topups,
    'float_pullouts_php',  floats.pullouts,
    'opening_float_php',   (baseline.v + floats.topups - floats.pullouts),
    'cash_payments_php',   cash_in.v,
    'gift_code_sales_php', gift_sales.v,
    'payments_by_method',  cash_in_by_method.v,
    'cash_payouts_php',    payouts.v,
    'expected_cash_php',   (baseline.v + floats.topups - floats.pullouts + cash_in.v + gift_sales.v - payouts.v),
    'closed',              (select to_jsonb(c) from closed c)
  )
  from baseline, floats, gift_sales, cash_in, cash_in_by_method, payouts;
$$;

-- Restate the post-0118 ACL rather than 0043's original `grant … to
-- authenticated` (0132 already did this once; repeating it here keeps the
-- intended state greppable at the point the function is (re)defined, per the
-- drmed-migrations skill's guidance on re-created functions).
revoke execute on function public.cash_drawer_state(date, uuid) from public, anon, authenticated;
grant  execute on function public.cash_drawer_state(date, uuid) to service_role;

-- =============================================================================
-- Finding 11 (go-live review): the liability accounting doesn't cover what
-- the app actually does.
--
-- Two real gaps in the "nets to zero" claim above:
--
--   1. Redemption is a WHOLE-USE voucher (redeemGiftCode() in
--      payments/new/actions.ts — applied = min(face_value, visit balance);
--      the remainder is forfeited, and reception cannot split a code across
--      visits — this is a deliberate product decision, not a bug). The
--      `payments` row (and therefore the bridge_payment_insert JE) only
--      carries the APPLIED amount, so a ₱1,000 code spent against a ₱600
--      bill only ever debits 2250 by ₱600. The other ₱400 stays credited to
--      "Gift Codes Outstanding" forever — the code is 'redeemed' (dead) but
--      the liability it created never clears.
--
--      Decision: book the forfeited remainder as INCOME at redemption
--      (standard "gift-card breakage" treatment), rather than changing
--      redemption to stop forfeiting — the whole-use design is intentional
--      and changing it means tracking a running remaining balance per code,
--      a materially bigger product change. Application code (redeemGiftCode)
--      now posts a SECOND two-line JE alongside the payment's own —
--      DR 2250 / CR 4600 Gift Code Breakage Income, for the forfeited amount
--      only — so the two JEs together always drain 2250 by exactly the face
--      value, whatever the split between "applied" and "forfeited" is.
--      voidPaymentAction reverses both JEs (the payment's own, via the
--      existing bridge trigger, and this breakage JE via
--      reverseJournalEntryBySource), so a voided redemption nets back to the
--      pre-redemption state — 2250 fully re-credited, breakage income
--      reversed, code back to 'purchased'.
--
--   2. A NON-CASH gift-code sale (gcash/maya/card/bank_transfer;
--      sellGiftCodeAction in gift-codes/actions.ts) never touches
--      eod_cash_adjustments — correctly, since it's not physical cash for
--      the drawer to count — but that also meant it posted NO journal entry
--      at all. Redeeming that code still debits 2250 by the mapped method
--      account regardless of how it was sold, so every non-cash-sold code's
--      eventual redemption drives 2250 further negative with no sale-side
--      credit to offset it.
--
--      Fix: sellGiftCodeAction now posts a sale-side JE directly for
--      non-cash methods too — DR the method's own account (the same
--      payment_method_account_map row `resolve_cash_account` would use for
--      an ordinary payment) / CR 2250 — mirroring the cash leg's DR 1010 /
--      CR 2250 (via eod_cash_adjustments) above. cancelGiftCodeAction
--      reverses it the same way the cash leg already reverses its
--      eod_cash_adjustments row.
--
-- Net result, per code, whatever the payment method or how much of it gets
-- redeemed:
--   SALE                 DR <method account>         CR 2250  face_value
--   REDEMPTION (applied)  DR 2250 (applied)            CR AR    applied
--   REDEMPTION (forfeit)  DR 2250 (forfeited, if any)  CR 4600  forfeited
--     — applied + forfeited == face_value, so 2250 is credited face_value
--       at sale and debited face_value (in up to two postings) at
--       redemption: nets to zero for every code, cash-sold or not, whole or
--       partially applied.
--   VOID of the redemption payment reverses BOTH postings above (the
--     payment's own JE via the existing bridge trigger, the breakage JE via
--     reverseJournalEntryBySource), so 2250 and 4600 return to their
--     pre-redemption balances and the code is redeemable again.
--   CANCEL of an unredeemed sale reverses the SALE posting (cash: via the
--     eod_cash_adjustments void trigger, as before; non-cash: via
--     reverseJournalEntryBySource), so 2250 returns to its pre-sale balance.
--
-- New source_kinds for these two application-posted JE types, so a
-- bookkeeper can tell them apart from manual entries and from the
-- cash-drawer bridge's 'cash_adjustment' kind. `add value` cannot run inside
-- a txn that then uses the value (see 0101_je_source_kind_petty_cash.sql) —
-- these are only referenced by application code at runtime, never by this
-- migration, so it's safe to add them here.
-- =============================================================================
alter type public.je_source_kind add value if not exists 'gift_code_sale';
alter type public.je_source_kind add value if not exists 'gift_code_breakage';

insert into public.chart_of_accounts (code, name, type, normal_balance, description)
values (
  '4600',
  'Gift Code Breakage Income',
  'revenue',
  'credit',
  'Forfeited remainder when a whole-use gift code is redeemed for less than its face value (see 0139) — recognised as income at the moment of redemption, when the voucher''s life ends and the unused portion can never be claimed.'
)
on conflict (code) do nothing;
