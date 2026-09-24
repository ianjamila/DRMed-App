-- 0164_send_out_lab_tagging
--
-- Send-out cost is the "Send Out" expense (6420) since 0159. Reception pays the
-- partner labs from the cash drawer, admins sometimes pay by bank, and the
-- history import already holds ~₱1.3M of it — but none of it says WHICH lab.
-- This migration makes every Send Out expense attributable to a partner lab and
-- adds the three read-only summaries the Send-out Labs report is built on.
--
--   1. vendors.is_partner_lab — which vendors appear in the "Which lab?" picker
--      (Hi Precision and Micromedic flagged here; admins tick others in Vendors).
--      Reception must read that short list, so vendors' single admin-ALL policy
--      is split into a read policy (admin, or reception for active partner labs)
--      and admin-only writes.
--   2. eod_cash_adjustments.vendor_id — the lab a petty-cash payout paid (the
--      Petty Cash tab, the drawer's Cash In & Out payout and Quick expense on
--      Clinic Cash all write this table).
--   3. journal_lines.vendor_id — the lab on a Send Out line that is NOT a
--      cash-drawer row or a vendor bill (Quick expense by bank/GCash/card, and
--      the history import, backfilled below from the free-text descriptions).
--      Bills already carry bills.vendor_id and drawer rows carry (2), so the
--      report resolves those through the entry's source instead of copying.
--   4. services.send_out_vendor_id backfilled from the send_out_lab text so
--      turnaround can be grouped by lab.
--   5. send_out_spend_by_lab / send_out_monthly_margin /
--      send_out_turnaround_by_lab — SECURITY INVOKER, so journal_lines' admin
--      RLS still decides who sees money.
--
-- Reversals: a reversal JE is attributed to the entry it reverses (bills and
-- drawer rows through that entry's source, tagged lines through the original
-- line with the same line_order). Both 'posted' and 'reversed' entries count,
-- so a voided payment and its reversal net to ₱0 inside the right lab instead
-- of the reversal alone being subtracted.

-- ---------------------------------------------------------------------------
-- 1. Partner labs
-- ---------------------------------------------------------------------------
alter table public.vendors
  add column is_partner_lab boolean not null default false;

comment on column public.vendors.is_partner_lab is
  'Outside lab the clinic sends tests to. Drives the "Which lab?" picker on '
  'Send Out expenses and the partner-lab list on send-out services (0164).';

update public.vendors
   set is_partner_lab = true
 where lower(trim(name)) in ('hi precision', 'micromedic');

drop policy if exists "vendors_admin_all" on public.vendors;

create policy "vendors: read"
  on public.vendors for select to authenticated
  using (
    (select public.has_role(array['admin']))
    or (is_partner_lab and is_active and (select public.has_role(array['reception'])))
  );

create policy "vendors: admin insert"
  on public.vendors for insert to authenticated
  with check ((select public.has_role(array['admin'])));

create policy "vendors: admin update"
  on public.vendors for update to authenticated
  using ((select public.has_role(array['admin'])))
  with check ((select public.has_role(array['admin'])));

create policy "vendors: admin delete"
  on public.vendors for delete to authenticated
  using ((select public.has_role(array['admin'])));

-- ---------------------------------------------------------------------------
-- 2. Lab on a cash-drawer payout
-- ---------------------------------------------------------------------------
alter table public.eod_cash_adjustments
  add column vendor_id uuid references public.vendors(id);

alter table public.eod_cash_adjustments
  add constraint eod_cash_adjustments_vendor_petty_cash_only
  check (vendor_id is null or kind = 'petty_cash');

create index idx_eod_cash_adjustments_vendor
  on public.eod_cash_adjustments(vendor_id)
  where vendor_id is not null;

comment on column public.eod_cash_adjustments.vendor_id is
  'Partner lab paid by a Send Out petty-cash payout (0164). Petty cash only.';

-- ---------------------------------------------------------------------------
-- 3. Lab on a journal line
-- ---------------------------------------------------------------------------
alter table public.journal_lines
  add column vendor_id uuid references public.vendors(id);

create index idx_journal_lines_vendor
  on public.journal_lines(vendor_id)
  where vendor_id is not null;

comment on column public.journal_lines.vendor_id is
  'Partner lab a Send Out (6420) line paid, when the entry is not a vendor bill '
  'or a cash-drawer row (those resolve through their source). 0164.';

-- History import: tag the lines whose description names the lab. Generic
-- lines ("SEND OUT JUN 1-15"), courier fees and refunds stay untagged — the
-- report shows them as "Not tagged" rather than guessing.
update public.journal_lines jl
   set vendor_id = v.id
  from public.journal_entries je, public.vendors v
 where je.id = jl.entry_id
   and je.source_kind = 'history_import'
   and jl.account_id = public.coa_uuid_for_code('6420')
   and jl.vendor_id is null
   and v.name = 'Hi Precision'
   and upper(coalesce(jl.description, je.description, ''))
       ~ '(^|[^A-Z])(HP|HIPRE|HI PRE|HI PRECISION)([^A-Z]|$)';

update public.journal_lines jl
   set vendor_id = v.id
  from public.journal_entries je, public.vendors v
 where je.id = jl.entry_id
   and je.source_kind = 'history_import'
   and jl.account_id = public.coa_uuid_for_code('6420')
   and jl.vendor_id is null
   and v.name = 'Micromedic'
   and upper(coalesce(jl.description, je.description, ''))
       ~ '(^|[^A-Z])(MICRO|MICROMEDIC)([^A-Z]|$)';

-- ---------------------------------------------------------------------------
-- 4. Send-out services → partner lab
-- ---------------------------------------------------------------------------
update public.services s
   set send_out_vendor_id = v.id
  from public.vendors v
 where s.is_send_out
   and s.send_out_vendor_id is null
   and v.is_partner_lab
   and lower(trim(s.send_out_lab)) = lower(trim(v.name));

-- ---------------------------------------------------------------------------
-- 5. Report functions
-- ---------------------------------------------------------------------------

-- Send Out (6420) spend per Manila month and partner lab. vendor_id null =
-- "Not tagged".
create or replace function public.send_out_spend_by_lab(
  p_start date default null,
  p_end   date default null
)
returns table (
  month       date,
  vendor_id   uuid,
  vendor_name text,
  spend_php   numeric,
  entries     bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with lines as (
    select
      je.posting_date,
      je.id                                   as entry_id,
      jl.debit_php - jl.credit_php            as amount,
      coalesce(
        -- an explicit tag: on this line, or on the reversed original's line
        case
          when je.source_kind = 'reversal' and je.reverses is not null then (
            select ol.vendor_id
              from public.journal_lines ol
             where ol.entry_id   = je.reverses
               and ol.account_id = jl.account_id
               and ol.line_order = jl.line_order
             limit 1)
          else jl.vendor_id
        end,
        -- otherwise the lab recorded on the entry's source
        case src.source_kind
          when 'cash_adjustment' then eca.vendor_id
          when 'bill_post'       then b.vendor_id
        end
      )                                       as vendor_id
    from public.journal_lines   jl
    -- Join the account by code rather than calling coa_uuid_for_code(): that
    -- helper is service_role-only (0119) and this function runs as the caller.
    join public.chart_of_accounts coa on coa.id = jl.account_id and coa.code = '6420'
    join public.journal_entries je  on je.id = jl.entry_id
    join public.journal_entries src on src.id = case
                                         when je.source_kind = 'reversal' and je.reverses is not null
                                           then je.reverses
                                         else je.id
                                       end
    left join public.eod_cash_adjustments eca
           on src.source_kind = 'cash_adjustment' and eca.id = src.source_id
    left join public.bills b
           on src.source_kind = 'bill_post' and b.id = src.source_id
    where je.status in ('posted', 'reversed')
      and (p_start is null or je.posting_date >= p_start)
      and (p_end   is null or je.posting_date <= p_end)
  )
  select
    date_trunc('month', l.posting_date)::date as month,
    l.vendor_id,
    v.name                                    as vendor_name,
    sum(l.amount)::numeric(14, 2)             as spend_php,
    count(distinct l.entry_id)                as entries
  from lines l
  left join public.vendors v on v.id = l.vendor_id
  group by 1, 2, 3;
$$;

comment on function public.send_out_spend_by_lab(date, date) is
  'Send-out Labs report: Send Out (6420) spend per Manila month and partner lab '
  '(null = not tagged). Voided entries and their reversals net to zero. '
  'SECURITY INVOKER — journal_lines RLS applies (admin only). 0164.';

-- Send-out revenue (released send-out tests) vs Send Out spend per month.
create or replace function public.send_out_monthly_margin(
  p_start date default null,
  p_end   date default null
)
returns table (
  month       date,
  tests       bigint,
  revenue_php numeric,
  spend_php   numeric,
  margin_php  numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  with revenue as (
    select
      date_trunc('month', (tr.released_at at time zone 'Asia/Manila'))::date as month,
      count(*)                                                                 as tests,
      sum(coalesce(tr.final_price_php, tr.base_price_php, 0))                  as revenue_php
    from public.test_requests tr
    join public.services s on s.id = tr.service_id
    join public.visits   v on v.id = tr.visit_id
    where s.is_send_out
      and tr.status      = 'released'
      and tr.released_at is not null
      and tr.deleted_at  is null
      and v.deleted_at   is null
      and (p_start is null or (tr.released_at at time zone 'Asia/Manila')::date >= p_start)
      and (p_end   is null or (tr.released_at at time zone 'Asia/Manila')::date <= p_end)
    group by 1
  ),
  spend as (
    select month, sum(spend_php) as spend_php
      from public.send_out_spend_by_lab(p_start, p_end)
     group by 1
  )
  select
    coalesce(r.month, s.month)                                           as month,
    coalesce(r.tests, 0)                                                 as tests,
    coalesce(r.revenue_php, 0)::numeric(14, 2)                           as revenue_php,
    coalesce(s.spend_php, 0)::numeric(14, 2)                             as spend_php,
    (coalesce(r.revenue_php, 0) - coalesce(s.spend_php, 0))::numeric(14, 2) as margin_php
  from revenue r
  full join spend s on s.month = r.month;
$$;

comment on function public.send_out_monthly_margin(date, date) is
  'Send-out Labs report: per Manila month, released send-out tests and their '
  'billed amount vs Send Out (6420) spend. SECURITY INVOKER. 0164.';

-- Request-to-release turnaround of send-out tests, per partner lab. Legacy
-- imports are excluded: they were stamped with one timestamp for both.
create or replace function public.send_out_turnaround_by_lab(
  p_start date default null,
  p_end   date default null
)
returns table (
  vendor_id      uuid,
  lab_name       text,
  tests          bigint,
  avg_hours      numeric,
  median_hours   numeric,
  p90_hours      numeric,
  with_promise   bigint,
  within_promise bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with t as (
    select
      s.send_out_vendor_id                                                 as vendor_id,
      coalesce(vn.name, nullif(trim(s.send_out_lab), ''), 'Not set')        as lab_name,
      extract(epoch from (tr.released_at - tr.requested_at)) / 3600.0       as hours,
      s.turnaround_hours                                                   as promise
    from public.test_requests tr
    join public.services s on s.id = tr.service_id
    join public.visits   v on v.id = tr.visit_id
    left join public.vendors vn on vn.id = s.send_out_vendor_id
    where s.is_send_out
      and tr.status      = 'released'
      and tr.deleted_at  is null
      and v.deleted_at   is null
      and tr.legacy_import_run_id is null
      and tr.requested_at is not null
      and tr.released_at  > tr.requested_at
      and (p_start is null or (tr.released_at at time zone 'Asia/Manila')::date >= p_start)
      and (p_end   is null or (tr.released_at at time zone 'Asia/Manila')::date <= p_end)
  )
  select
    vendor_id,
    lab_name,
    count(*)                                                              as tests,
    round(avg(hours)::numeric, 1)                                         as avg_hours,
    round((percentile_cont(0.5) within group (order by hours))::numeric, 1) as median_hours,
    round((percentile_cont(0.9) within group (order by hours))::numeric, 1) as p90_hours,
    count(*) filter (where promise is not null)                          as with_promise,
    count(*) filter (where promise is not null and hours <= promise)     as within_promise
  from t
  group by vendor_id, lab_name;
$$;

comment on function public.send_out_turnaround_by_lab(date, date) is
  'Send-out Labs report: request-to-release hours of live send-out tests per '
  'partner lab (legacy imports excluded). SECURITY INVOKER. 0164.';

-- Per 0119 new functions are service_role-only; these are called by a signed-in
-- admin session through the RLS-scoped client.
revoke execute on function public.send_out_spend_by_lab(date, date)      from public, anon;
revoke execute on function public.send_out_monthly_margin(date, date)    from public, anon;
revoke execute on function public.send_out_turnaround_by_lab(date, date) from public, anon;
grant  execute on function public.send_out_spend_by_lab(date, date)      to authenticated, service_role;
grant  execute on function public.send_out_monthly_margin(date, date)    to authenticated, service_role;
grant  execute on function public.send_out_turnaround_by_lab(date, date) to authenticated, service_role;

-- Post-conditions.
do $$
begin
  if (select count(*) from public.vendors where is_partner_lab) < 1
     and exists (select 1 from public.vendors where lower(trim(name)) in ('hi precision', 'micromedic')) then
    raise exception '0164: partner labs were not flagged';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'vendors'
              and policyname = 'vendors_admin_all') then
    raise exception '0164: vendors_admin_all still present';
  end if;
end;
$$;
