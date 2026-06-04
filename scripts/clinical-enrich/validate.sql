-- Clinical enrichment validation (read-only).
--   docker exec -i supabase_db_DRMed psql -U postgres -d postgres < scripts/clinical-enrich/validate.sql
\echo '=== 1. doctor attribution coverage (legacy consults) ==='
select
  count(*) filter (where v.attending_physician_id is not null) as attributed,
  count(*) filter (where v.attending_physician_id is null) as other_or_null,
  count(*) as total
from public.visits v
join public.test_requests t on t.visit_id = v.id and t.legacy_import_run_id is not null
join public.services s on s.id = t.service_id and s.kind = 'doctor_consultation'
where v.legacy_import_run_id is not null;

\echo '=== 2. discount_kind distribution (legacy test_requests with a discount) ==='
select coalesce(discount_kind,'(null)') as kind, count(*)
from public.test_requests where legacy_import_run_id is not null and coalesce(discount_amount_php,0) > 0
group by 1 order by 2 desc;

\echo '=== 3. new/repeat coverage (legacy lab visits) ==='
select coalesce(source_new_repeat,'(null)') as marker, count(*)
from public.visits where legacy_import_run_id is not null group by 1 order by 2 desc;

\echo '=== 4. GL-SILENCE assertion: zero JEs reference legacy clinical rows (must be 0) ==='
select count(*) as must_be_zero
from public.journal_entries je
where je.source_kind in ('payment','test_request')
  and je.source_id in (
    select id from public.payments where legacy_import_run_id is not null
    union all select id from public.test_requests where legacy_import_run_id is not null
  );

\echo '=== 5. consults per physician (top) ==='
select coalesce(p.full_name,'(Other / unattributed)') as physician, count(*) as consults
from public.visits v
join public.test_requests t on t.visit_id = v.id and t.legacy_import_run_id is not null
join public.services s on s.id = t.service_id and s.kind = 'doctor_consultation'
left join public.physicians p on p.id = v.attending_physician_id
where v.legacy_import_run_id is not null
group by 1 order by 2 desc;
