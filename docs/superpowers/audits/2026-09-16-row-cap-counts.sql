-- Read-only production count audit, 2026-09-16 (Asia/Manila).
-- Counts only; no identifiers, names, values, or PHI returned.
-- Global SQL cardinalities bound role-visible subsets; this is not an RLS proof.

-- Batch 1
with day_visits as (
 select visit_date, count(*) n from visits v join patients p on p.id=v.patient_id where v.deleted_at is null and visit_date <= (now() at time zone 'Asia/Manila')::date group by visit_date
), day_orders as (
 select v.visit_date,count(*) n from test_requests t join visits v on v.id=t.visit_id join services s on s.id=t.service_id where t.is_package_header=false and t.status<>'cancelled' and t.deleted_at is null and v.deleted_at is null group by v.visit_date
), unacked as (
 select t.assigned_to from critical_alerts c join test_requests t on t.id=c.test_request_id where c.acknowledged_at is null
), cohorts as (
 select id,booking_group_id from appointments where (scheduled_at >= ((now() at time zone 'Asia/Manila')::date::timestamp at time zone 'Asia/Manila') and scheduled_at < (((now() at time zone 'Asia/Manila')::date+31)::timestamp at time zone 'Asia/Manila')) or (scheduled_at is null and status in ('confirmed','arrived')) or status='pending_callback'
)
select 'Q42_max_live_visits_per_selectable_date' metric, coalesce(max(n),0)::bigint n from day_visits
union all select 'Q42_dates_over_1000',count(*) from day_visits where n>1000
union all select 'Q152_max_live_nonheader_noncancelled_orders_per_date',coalesce(max(n),0) from day_orders
union all select 'Q152_today',coalesce(max(n),0) from day_orders where visit_date=(now() at time zone 'Asia/Manila')::date
union all select 'Q69_global_unacknowledged',count(*) from unacked
union all select 'Q69_max_assigned_staff_unacknowledged',coalesce(max(n),0) from (select count(*) n from unacked where assigned_to is not null group by assigned_to) s
union all select 'Q77_loaded_appointment_rows',count(*) from cohorts
union all select 'Q77_loaded_booking_groups',count(distinct booking_group_id) from cohorts
union all select 'Q77_matching_attachments',count(*) from appointment_attachments where booking_group_id in (select booking_group_id from cohorts)
union all select 'Q77_all_attachments',count(*) from appointment_attachments
union all select 'Q81_max_loaded_booking_group_rows',coalesce(max(n),0) from (select count(*) n from cohorts group by coalesce(booking_group_id,id)) s
union all select 'Q81_max_any_booking_group_rows',coalesce(max(n),0) from (select count(*) n from appointments group by coalesce(booking_group_id,id)) s
union all select 'Q131_Q134_max_business_date_shift',coalesce(max(n),0) from (select count(*) n from eod_cash_adjustments group by business_date,shift_id) s
union all select 'Q135_max_petty_cash_per_date',coalesce(max(n),0) from (select count(*) n from eod_cash_adjustments where kind='petty_cash' group by business_date) s
union all select 'cash_adjustments_all',count(*) from eod_cash_adjustments
union all select 'Q241_future_closures',count(*) from clinic_closures where closed_on >= (now() at time zone 'Asia/Manila')::date
union all select 'Q245_all_trueups',count(*) from cogs_send_out_trueups
union all select 'Q270_max_nonvoid_trueups_per_manila_year',coalesce(max(n),0) from (select count(*) n from cogs_send_out_trueups where voided_at is null group by extract(year from matched_at at time zone 'Asia/Manila')) s
union all select 'Q248_active_inventory_items',count(*) from v_inventory_balances where is_active=true
union all select 'Q315_max_nonvoid_disbursements_per_year',coalesce(max(n),0) from (select count(*) n from doctor_pf_disbursements where voided_at is null group by extract(year from posted_date)) s
union all select 'Q332_purchased_all_time_upper_bound',count(*) from gift_codes where purchased_at is not null
union all select 'Q344_active_subscribers',count(*) from subscribers where unsubscribed_at is null
union all select 'Q393_max_batches_per_provider',coalesce(max(n),0) from (select count(*) n from hmo_claim_batches group by provider_id) s;

-- Batch 2
with history as (
 select *,dense_rank() over(order by effective_from desc) time_rank from service_price_history
), top_history as (
 select service_id,effective_from from service_price_history order by effective_from desc limit 1000
), latest as (
 select service_id,max(effective_from) last_at from history group by service_id
), downloads as (
 select id,resource_id,metadata from audit_log where action='result.downloaded' and resource_type='result'
), shapes as (
 select id, 'meta' shape, metadata->>'test_request_id' tid from downloads where metadata->>'test_request_id' is not null
 union all select d.id,'linked',r.test_request_id::text from downloads d join result_test_requests r on r.result_id::text=d.resource_id::text
 union all select d.id,'merged',j.value from downloads d cross join lateral jsonb_array_elements_text(case when jsonb_typeof(d.metadata->'merged_component_ids')='array' then d.metadata->'merged_component_ids' else '[]'::jsonb end) j
 union all select d.id,'normalized',j.value from downloads d cross join lateral jsonb_array_elements_text(case when jsonb_typeof(d.metadata->'test_request_ids')='array' then d.metadata->'test_request_ids' else '[]'::jsonb end) j
), snapshot_dates as (
 select snapshot_date,count(*) n,dense_rank() over(order by snapshot_date desc) rn from hmo_aging_snapshots group by snapshot_date
)
select 'Q265_history_rows' metric,count(*)::bigint n from history
union all select 'Q265_services_with_history',count(*) from latest
union all select 'Q265_services_latest_missing_newest_1000',count(*) from latest l where not exists(select 1 from top_history t where t.service_id=l.service_id and t.effective_from=l.last_at)
union all select 'Q201_download_events',count(*) from downloads
union all select 'Q201_max_meta_matches',coalesce(max(n),0) from(select count(distinct id) n from shapes where shape='meta' group by tid) s
union all select 'Q201_max_linked_matches',coalesce(max(n),0) from(select count(distinct id) n from shapes where shape='linked' group by tid) s
union all select 'Q201_max_merged_matches',coalesce(max(n),0) from(select count(distinct id) n from shapes where shape='merged' group by tid) s
union all select 'Q201_max_normalized_matches',coalesce(max(n),0) from(select count(distinct id) n from shapes where shape='normalized' group by tid) s
union all select 'Q201_max_union_matches',coalesce(max(n),0) from(select count(distinct id) n from shapes group by tid) s
union all select 'Q201_max_result_links_per_test',coalesce(max(n),0) from(select count(*) n from result_test_requests group by test_request_id) s
union all select 'Q428_snapshot_rows',count(*) from hmo_aging_snapshots
union all select 'Q428_distinct_dates',count(*) from snapshot_dates
union all select 'Q428_rows_in_latest_24_dates',coalesce(sum(n),0) from snapshot_dates where rn<=24
union all select 'Q428_rows_before_oldest_latest_24_date',coalesce(sum(n),0) from snapshot_dates where rn<(select max(rn) from snapshot_dates where rn<=24)
union all select 'Q428_max_rows_per_date',coalesce(max(n),0) from snapshot_dates
union all select 'Q311_statements',count(*) from bank_statements
union all select 'Q319_max_lines_per_statement',coalesce(max(n),0) from(select count(*) n from bank_statement_lines group by statement_id) s
union all select 'Q322_max_unmatched_lines_per_statement',coalesce(max(n),0) from(select count(*) n from bank_statement_lines where matched_je_line_id is null group by statement_id) s
union all select 'Q320_Q323_global_matched_lines',count(*) from bank_statement_lines where matched_je_line_id is not null
union all select 'Q217_all_vendors',count(*) from vendors
union all select 'Q217_all_bills',count(*) from bills
union all select 'Q217_max_embedded_bills_per_vendor',coalesce(max(n),0) from(select count(*) n from bills group by vendor_id) s
union all select 'Q218_outstanding_nonvoid',count(*) from bills where outstanding_amount>0 and status<>'voided'
union all select 'Q219_drafts',count(*) from bills where status='draft'
union all select 'Q221_nonvoid_since_month_start',count(*) from bills where bill_date>=date_trunc('month',now() at time zone 'Asia/Manila')::date and status<>'voided';

-- Batch 3
with posted_daily as (
 select l.account_id,e.posting_date,count(*) n from journal_lines l join journal_entries e on e.id=l.entry_id where e.status='posted' group by l.account_id,e.posting_date
), windows as (
 select sum(n) over(partition by account_id order by posting_date::timestamp range between interval '7 days' preceding and interval '7 days' following) n from posted_daily
), statement_windows as (
 select s.account_id,min(b.transaction_date) lo,max(b.transaction_date) hi from bank_statements s join bank_statement_lines b on b.statement_id=s.id where b.matched_je_line_id is null group by s.id,s.account_id
), actual_counts as (
 select (select count(*) from journal_lines l join journal_entries e on e.id=l.entry_id where l.account_id=w.account_id and e.status='posted' and e.posting_date between w.lo-7 and w.hi+7) detail_n,
 (select count(*) from journal_lines l join journal_entries e on e.id=l.entry_id where l.account_id=w.account_id and e.status='posted' and e.posting_date between w.lo-3 and w.hi+3) auto_n from statement_windows w
), months as (
 select distinct account_id,date_trunc('month',posting_date)::date lo from posted_daily
), monthly_windows as (
 select (select sum(n) from posted_daily d where d.account_id=m.account_id and d.posting_date between m.lo-3 and (m.lo+interval '1 month')::date+2) n from months m
)
select 'journal_lines' metric,count(*)::bigint n from journal_lines
union all select 'journal_entries',count(*) from journal_entries
union all select 'Q321_actual_statement_windows',count(*) from statement_windows
union all select 'Q321_max_actual_candidates',coalesce(max(detail_n),0) from actual_counts
union all select 'Q324_max_actual_candidates',coalesce(max(auto_n),0) from actual_counts
union all select 'Q321_max_posted_account_15_day_window',coalesce(max(n),0) from windows
union all select 'Q324_max_posted_account_month_plus_3_days',coalesce(max(n),0) from monthly_windows;

-- Batch 4
with eligible as (
 select id from chart_of_accounts where type='asset' and code in ('1010','1020','1021','1030')
), daily as (
 select l.account_id,e.posting_date,count(*) n from journal_lines l join journal_entries e on e.id=l.entry_id where e.status='posted' and l.account_id in(select id from eligible) group by l.account_id,e.posting_date
), rolling as (
 select sum(n) over(partition by account_id order by posting_date::timestamp range between interval '7 days' preceding and interval '7 days' following) n from daily
), months as (
 select distinct account_id,date_trunc('month',posting_date)::date lo from daily
), windows as (
 select (select sum(n) from daily d where d.account_id=m.account_id and d.posting_date between m.lo-7 and (m.lo+interval '1 month')::date+6) n7,
 (select sum(n) from daily d where d.account_id=m.account_id and d.posting_date between m.lo-3 and (m.lo+interval '1 month')::date+2) n3 from months m
)
select 'eligible_bank_accounts' metric,count(*)::bigint n from eligible
union all select 'Q321_eligible_max_15_day_window',coalesce(max(n),0) from rolling
union all select 'Q321_eligible_max_month_plus_7_days',coalesce(max(n7),0) from windows
union all select 'Q324_eligible_max_month_plus_3_days',coalesce(max(n3),0) from windows;

-- Batch 5
with daily as (
 select l.account_id,e.posting_date,count(*) n from journal_lines l join journal_entries e on e.id=l.entry_id join chart_of_accounts a on a.id=l.account_id where e.status='posted' and a.type='asset' and a.code in ('1010','1020','1021','1030') group by l.account_id,e.posting_date
), quarters as (select distinct account_id,date_trunc('quarter',posting_date)::date lo from daily),
windows as (
 select (select sum(n) from daily d where d.account_id=q.account_id and d.posting_date between q.lo-7 and (q.lo+interval '3 months')::date+6) n7,
 (select sum(n) from daily d where d.account_id=q.account_id and d.posting_date between q.lo-3 and (q.lo+interval '3 months')::date+2) n3 from quarters q
)
select 'Q321_eligible_max_quarter_plus_7_days' metric,coalesce(max(n7),0)::bigint n from windows
union all select 'Q324_eligible_max_quarter_plus_3_days',coalesce(max(n3),0)::bigint from windows;
