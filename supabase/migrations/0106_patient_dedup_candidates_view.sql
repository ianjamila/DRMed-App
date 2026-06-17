-- 0106_patient_dedup_candidates_view.sql
-- Candidate duplicate PAIRS (id_a < id_b) sharing >=1 equality blocking key.
-- Emits raw fields for both sides; scoring happens in TS (scorePair).

create or replace view public.v_patient_dedup_candidate_pairs
with (security_invoker = true) as
with active as (
  select id, drm_id, first_name, last_name, middle_name, birthdate, email,
         phone_normalized, address, sex,
         (legacy_import_run_id is not null) as is_legacy, created_at
  from public.patients
  where merged_into_id is null
),
pairs as (
  select a.id as id_a, b.id as id_b
  from active a join active b
    on a.id < b.id and a.email is not null and a.email = b.email
  union
  select a.id, b.id
  from active a join active b
    on a.id < b.id and a.phone_normalized is not null
       and a.phone_normalized = b.phone_normalized
  union
  select a.id, b.id
  from active a join active b
    on a.id < b.id and a.birthdate is not null and a.birthdate = b.birthdate
       and lower(trim(a.last_name)) = lower(trim(b.last_name))
)
select
  p.id_a, p.id_b,
  a.drm_id as a_drm_id, a.first_name as a_first_name, a.last_name as a_last_name,
  a.middle_name as a_middle_name, a.birthdate as a_birthdate, a.email as a_email,
  a.phone_normalized as a_phone_normalized, a.address as a_address, a.sex as a_sex,
  a.is_legacy as a_is_legacy, a.created_at as a_created_at,
  b.drm_id as b_drm_id, b.first_name as b_first_name, b.last_name as b_last_name,
  b.middle_name as b_middle_name, b.birthdate as b_birthdate, b.email as b_email,
  b.phone_normalized as b_phone_normalized, b.address as b_address, b.sex as b_sex,
  b.is_legacy as b_is_legacy, b.created_at as b_created_at
from pairs p
join active a on a.id = p.id_a
join active b on b.id = p.id_b;
