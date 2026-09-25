-- 0173_ledger_reversal_pairs.sql
-- ============================================================================
-- WHAT / WHY
-- ============================================================================
-- Reversing a journal entry marks the ORIGINAL `journal_entries.status =
-- 'reversed'` and inserts a mirror entry (`source_kind = 'reversal'`,
-- `reverses = <original id>`, `status = 'posted'`, debit/credit swapped so
-- the pair nets to zero — see `reverseJournalEntryBySource` in
-- src/lib/accounting/journal-entry.ts). A report that sums journal lines
-- filtered to `status = 'posted'` therefore keeps the mirror and drops the
-- original — a reversal SUBTRACTS the amount twice instead of netting to
-- zero. Verified on prod: June 2026 showed −₱418,319 of expenses, Cash on
-- Hand was overstated by ₱417,959, and a September undo-release showed −₱360
-- revenue.
--
-- Rule going forward (also applied to the TypeScript ledger reports in this
-- PR, via src/lib/accounting/ledger-status.ts's `LEDGER_TOTAL_STATUSES`):
-- every ledger TOTAL/aggregation counts `status in ('posted', 'reversed')`.
-- Operational LOOKUPS that find "the live entry to act on" (bridge_*/ap_*
-- functions, cash-drawer close, HMO claim linking, PF disbursement void,
-- coa_account_has_open_period_postings, journal-entry.ts, the bank-rec
-- JE-candidate matcher) are UNCHANGED and stay posted-only on purpose — a
-- reversed entry is no longer the live record to link against, and letting a
-- reversed-and-superseded duplicate back into a 1:1 bank-statement match
-- would create ambiguous candidates.
--
-- Sections:
--   A. Redefine v_ops_daily_expense_accounts, v_ops_daily_expenses,
--      v_ops_daily_pnl — status filter only, column lists unchanged.
--   B. Redefine bridge_replay_summary (a $ aggregation/report) the same way.
--      coa_account_has_open_period_postings is a deactivation GATE, not a
--      report — left unchanged; see its comment below.
--   C. Data fix: re-date the 150 reversal entries that cancelled the 75
--      duplicate AP bills found during the 2026 books reconciliation (75
--      bill_post + 75 bill_payment reversals), so each reversal lands on the
--      SAME posting_date as the entry it cancels instead of the day the
--      correction was keyed in (June 2026). Under posted+reversed reports the
--      pair then nets to zero in every month; left in June, Jan–May would
--      show the duplicates and June −₱418,319.
--
-- ============================================================================
-- DEPLOY ORDER — read before merging
-- ============================================================================
-- Push this migration to prod RIGHT BEFORE this PR merges. The report-filter
-- change (posted+reversed) and the re-dating in Section C must go live
-- TOGETHER:
--   - Re-dated reversals read under a POSTED-ONLY report (old app code) would
--     understate Jan–May 2026 (the pair's remaining posted-only leg lands in
--     the wrong month).
--   - A posted+reversed report (new app code) WITHOUT the re-dating would
--     inflate Jan–May 2026 (both legs land in June, netting to zero there
--     instead of in the months the duplicate bills actually belonged to).
-- Neither half is safe to ship alone.

-- ============================================================================
-- A. v_ops_daily_expense_accounts, v_ops_daily_expenses, v_ops_daily_pnl
-- ============================================================================
-- Current definitions taken from 0094_ops_daily_expenses.sql and
-- 0096_ops_expense_pnl_views.sql (verified against the local DB via
-- pg_get_viewdef — neither has been redefined since). Only the `je.status`
-- filter changes; column lists, aliases, grouping and `security_invoker`
-- are unchanged. `create or replace view` REPLACES reloptions rather than
-- merging them, so `with (security_invoker = on)` is restated on all three —
-- omitting it would silently revert the view to running with its owner's
-- rights (src/lib/supabase/hardened-views.test.ts guards the views that are
-- already registered there; these three aren't, and adding them is out of
-- scope for this fix). Grants are NOT restated: 0148 revoked anon/
-- authenticated on all nine v_ops_daily_* views, and unlike reloptions,
-- grants survive a `create or replace view`.

create or replace view public.v_ops_daily_expenses
with (security_invoker = on) as
select
  je.posting_date as business_date,
  coalesce(sum(jl.debit_php - jl.credit_php), 0)::numeric(14,2) as expense_php
from public.journal_lines jl
join public.journal_entries je on je.id = jl.entry_id
join public.chart_of_accounts coa on coa.id = jl.account_id
where coa.type = 'expense'
  and je.status in ('posted', 'reversed')
group by je.posting_date;

alter view public.v_ops_daily_expenses owner to postgres;

create or replace view public.v_ops_daily_expense_accounts
with (security_invoker = on) as
select
  je.posting_date                                              as business_date,
  coa.code,
  coa.name,
  coalesce(sum(jl.debit_php - jl.credit_php), 0)::numeric(14,2) as expense_php
from public.journal_lines jl
join public.journal_entries je   on je.id = jl.entry_id
join public.chart_of_accounts coa on coa.id = jl.account_id
where coa.type = 'expense'
  and je.status in ('posted', 'reversed')
group by je.posting_date, coa.code, coa.name;

alter view public.v_ops_daily_expense_accounts owner to postgres;

create or replace view public.v_ops_daily_pnl
with (security_invoker = on) as
select
  je.posting_date as business_date,
  coalesce(sum(case when coa.type='revenue'
    then (jl.credit_php - jl.debit_php) else 0 end),0)::numeric(14,2) as revenue_php,
  coalesce(sum(case when coa.type='contra_revenue'
    then (jl.debit_php - jl.credit_php) else 0 end),0)::numeric(14,2) as contra_revenue_php,
  coalesce(sum(case when coa.type='expense'
    then (jl.debit_php - jl.credit_php) else 0 end),0)::numeric(14,2) as expense_php
from public.journal_lines jl
join public.journal_entries je   on je.id = jl.entry_id
join public.chart_of_accounts coa on coa.id = jl.account_id
where je.status in ('posted', 'reversed')
  and coa.type in ('revenue','contra_revenue','expense')
group by je.posting_date;

alter view public.v_ops_daily_pnl owner to postgres;

-- ============================================================================
-- B. SQL functions that aggregate journal lines for a report
-- ============================================================================
-- bridge_replay_summary(p_start, p_end) is a diagnostic REPORT over GL bridge
-- activity created in a time window (je_count, by_source_kind,
-- suspense_postings, totals_by_account, unbalanced_count) — a $ aggregation,
-- same category as the views above, so its `status = 'posted'` filters
-- become `status in ('posted', 'reversed')` throughout. Current definition
-- taken from 0034_hmo_ar_subledger.sql Section 13 (verified against the
-- local DB via pg_get_functiondef — it is still the latest). `security
-- definer` + `set search_path = public` are restated because CREATE OR
-- REPLACE FUNCTION requires the full body; existing grants (0118 revoked
-- public/anon/authenticated, granted service_role) survive the replace and
-- are not restated.
create or replace function public.bridge_replay_summary(
  p_start timestamptz,
  p_end   timestamptz
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'window', jsonb_build_object('start', p_start, 'end', p_end),
    'je_count', (
      select count(*) from public.journal_entries
      where created_at between p_start and p_end and status in ('posted', 'reversed')
    ),
    'by_source_kind', coalesce((
      select jsonb_object_agg(source_kind::text, n)
      from (
        select je.source_kind, count(*) as n
          from public.journal_entries je
         where je.created_at between p_start and p_end
           and je.status in ('posted', 'reversed')
         group by je.source_kind
      ) bsk
    ), '{}'::jsonb),
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
        and je.status in ('posted', 'reversed')
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
          and je.status in ('posted', 'reversed')
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
          and je.status in ('posted', 'reversed')
        group by je.id
        having sum(jl.debit_php) <> sum(jl.credit_php)
      ) unbal
    )
  );
$$;

-- coa_account_has_open_period_postings(p_account_id) is NOT changed. It is a
-- boolean deactivation GATE ("Strict deactivation guard" in
-- src/app/.../chart-of-accounts/actions.ts's toggleAccountActiveAction), not
-- a $ report — it answers "does this account still have a LIVE posting in an
-- open period", the same category as the other operational lookups this PR
-- leaves alone. A reversed line is no longer a live obligation against the
-- account, so it correctly does not block deactivation on its own; staying
-- posted-only here is intentional, not an oversight.

-- ============================================================================
-- C. Data fix — re-date the duplicate-bill reversal entries
-- ============================================================================
-- Owner-approved (2026 books reconciliation): 75 duplicate AP bills were
-- voided and their journal effect reversed, but the reversal entries were
-- keyed in on the date the correction was MADE (June 2026) rather than the
-- bill's own date. Re-date each reversal to match the original entry's
-- posting_date so the pair nets to zero in the period the duplicate bill
-- actually belonged to, not in June.
--
-- Targets: reversal entries (r) whose original (o) is either
--   * a `bill_post` entry — o.source_id is the voided BILL's id, or
--   * a `bill_payment` entry — o.source_id is a BILL_PAYMENTS id, reached
--     through bill_payment_allocations. (On prod each of the 75 payments
--     is allocated only to voided reconciliation bills; the guard below
--     refuses to run if any of them also pays a live bill.)
-- The target set is computed ONCE into a temp table and reused for the
-- guard, the audit rows, the update and the post-condition, so the four
-- steps cannot disagree.
--
-- Guard: exactly 0 (already applied, or nothing to do locally) or 150 rows
-- (75 bill_post + 75 bill_payment reversals) — abort on any other count.
create temp table _0173_targets as
with voided_bills as (
  select id from public.bills
  where status = 'voided'
    and void_reason like '2026 books reconciliation%'
),
voided_bill_payments as (
  select distinct a.payment_id
  from public.bill_payment_allocations a
  where a.bill_id in (select id from voided_bills)
)
select
  r.id,
  r.entry_number,
  r.posting_date as old_posting_date,
  o.posting_date as new_posting_date,
  o.entry_number as reverses_entry_number,
  o.source_kind  as reverses_source_kind
from public.journal_entries r
join public.journal_entries o on o.id = r.reverses
where r.source_kind = 'reversal'
  and r.status = 'posted'
  and o.status = 'reversed'
  and (
    (o.source_kind = 'bill_post'    and o.source_id in (select id from voided_bills))
    or
    (o.source_kind = 'bill_payment' and o.source_id in (select payment_id from voided_bill_payments))
  )
  and r.posting_date is distinct from o.posting_date;

do $$
declare
  v_count int;
  v_posts int;
  v_payments int;
  v_mixed int;
begin
  select count(*),
         count(*) filter (where reverses_source_kind = 'bill_post'),
         count(*) filter (where reverses_source_kind = 'bill_payment')
    into v_count, v_posts, v_payments
  from _0173_targets;

  if v_count not in (0, 150) or v_posts <> v_payments then
    raise exception
      '0173: expected 0 or 150 (75 + 75) duplicate-bill reversal rows to re-date, found % (bill_post %, bill_payment %)',
      v_count, v_posts, v_payments;
  end if;

  -- A payment that also settled a LIVE bill is not a pure duplicate.
  select count(*) into v_mixed
  from public.bill_payment_allocations a
  join public.bills b on b.id = a.bill_id
  where a.payment_id in (
          select o.source_id
          from _0173_targets t
          join public.journal_entries r on r.id = t.id
          join public.journal_entries o on o.id = r.reverses
          where t.reverses_source_kind = 'bill_payment'
        )
    and not (b.status = 'voided' and b.void_reason like '2026 books reconciliation%');
  if v_mixed <> 0 then
    raise exception '0173: % allocation(s) tie a target payment to a live bill — not re-dating', v_mixed;
  end if;

  raise notice '0173: % duplicate-bill reversal row(s) to re-date.', v_count;
end $$;

-- Audit row per re-dated entry, written BEFORE the update (old date kept so
-- the change can be undone from audit_log alone).
insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
select
  null,
  'system',
  'gl.reversal_posting_date_redated',
  'journal_entries',
  t.id,
  jsonb_build_object(
    'entry_number', t.entry_number,
    'old_posting_date', t.old_posting_date,
    'new_posting_date', t.new_posting_date,
    'reverses_entry_number', t.reverses_entry_number,
    'reverses_source_kind', t.reverses_source_kind,
    'reason', '0173: date the duplicate-bill reversal on the bill''s own date so the pair nets to zero in every period'
  )
from _0173_targets t;

-- Apply. trg_je_period_lock_check still runs (status stays 'posted', so it
-- checks the NEW posting_date's period) — left in place, not disabled; all
-- periods are open on prod as of this migration, but a genuinely closed
-- target period would correctly abort the whole migration.
update public.journal_entries r
set posting_date = t.new_posting_date
from _0173_targets t
where r.id = t.id;

-- Post-condition: every target now shares its original's posting_date.
do $$
declare
  v_remaining int;
begin
  select count(*) into v_remaining
  from _0173_targets t
  join public.journal_entries r on r.id = t.id
  join public.journal_entries o on o.id = r.reverses
  where r.posting_date is distinct from o.posting_date;

  if v_remaining <> 0 then
    raise exception
      '0173: % duplicate-bill reversal row(s) still differ from their original''s posting_date after the update', v_remaining;
  end if;

  raise notice '0173: duplicate-bill reversal re-dating complete, 0 rows remaining out of sync.';
end $$;

drop table _0173_targets;
