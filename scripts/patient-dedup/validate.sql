-- scripts/patient-dedup/validate.sql
-- Run after committing the de-dup pass (via Supabase MCP / psql against prod).

-- 1. Live vs tombstoned patient counts.
select
  count(*) filter (where merged_into_id is null) as live_patients,
  count(*) filter (where merged_into_id is not null) as tombstoned;

-- 2. High-confidence duplicate clusters remaining (expect ~0 after the pass).
with live as (
  select id,
         lower(regexp_replace(coalesce(last_name,'')||'|'||coalesce(first_name,''),'\s+','','g')) as namekey,
         birthdate,
         nullif(regexp_replace(coalesce(phone,''),'\D','','g'),'') as phonekey
  from patients where merged_into_id is null
)
select
  (select count(*) from (select namekey,birthdate from live where namekey<>'|' and birthdate is not null group by 1,2 having count(*)>1) x) as namedob_clusters_remaining,
  (select count(*) from (select namekey,phonekey from live where namekey<>'|' and phonekey is not null and length(phonekey)>=7 group by 1,2 having count(*)>1) x) as namephone_clusters_remaining;

-- 3. Audit rows written by this pass.
select count(*) as patient_merged_audit_rows
from audit_log where action = 'patient.merged' and actor_type = 'system';

-- 4. GL-silence: this pass writes no journal entries. Expect 0 new JE lines
--    referencing a merged patient's visits beyond what existed pre-pass.
--    (Re-use the backfill/enrich GL-silence assertion — the merge touches no
--    payments/test_requests status, so the 0091 guard has nothing to fire on.)
select count(*) as je_rows_total from journal_entries;  -- record before/after; expect unchanged by the merge step itself
