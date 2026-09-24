-- =============================================================================
-- 0157_resolve_patient_referral_source.sql
-- =============================================================================
-- "How did you hear about us?" on the public website forms (/schedule and
-- /register). Both create their patient through resolve_patient_guarded
-- (0112), whose insert listed only the name/contact columns — so every
-- website-created patient landed with referral_source NULL. On 2026-09-24 all
-- 12 patients created since 2026-09-11 were online pre-registrations and every
-- one was blank, which left the Facebook-ads review unable to count patients.
--
-- Same function, same signature, same lock discipline. One change: a NEW row
-- also takes `p_fields->>'referral_source'`, looked up in referral_sources
-- (0055) so an id the lookup does not know becomes NULL instead of an FK
-- error — a marketing answer must never fail a booking. A MATCHED row is still
-- returned untouched: an anonymous form never writes onto an existing patient.
-- The staff "+ New appointment" slide-over sends no referral_source, so its
-- new patients keep NULL exactly as before.
-- =============================================================================

create or replace function public.resolve_patient_guarded(
  p_email text, p_last_name text, p_birthdate date, p_fields jsonb
)
returns table (id uuid, drm_id text, reused boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v record;
begin
  perform pg_advisory_xact_lock(
    hashtext('patient_resolve:' || lower(p_email) || ':' || lower(p_last_name) || ':' || p_birthdate::text)
  );
  select p.id, p.drm_id into v
    from public.patients p
   where p.email = lower(p_email) and p.last_name = p_last_name and p.birthdate = p_birthdate
   limit 1;
  if found then
    return query select v.id, v.drm_id, true;
    return;
  end if;
  return query
  insert into public.patients (
    first_name, last_name, middle_name, birthdate, sex, phone, email, address, pre_registered,
    referral_source
  ) values (
    p_fields->>'first_name', p_fields->>'last_name', nullif(p_fields->>'middle_name',''),
    (p_fields->>'birthdate')::date,
    nullif(p_fields->>'sex',''),
    nullif(p_fields->>'phone',''), lower(p_email), nullif(p_fields->>'address',''),
    true,
    (select rs.id from public.referral_sources rs where rs.id = nullif(p_fields->>'referral_source',''))
  ) returning patients.id, patients.drm_id, false;
end;
$$;

-- `create or replace` keeps the existing ACL, but restate it (0112 + 0113:
-- service_role only). On hosted Supabase `revoke … from public` alone leaves
-- the direct anon/authenticated grants, so name them.
revoke all on function public.resolve_patient_guarded(text, text, date, jsonb) from public;
revoke execute on function public.resolve_patient_guarded(text, text, date, jsonb) from anon, authenticated;
grant execute on function public.resolve_patient_guarded(text, text, date, jsonb) to service_role;
