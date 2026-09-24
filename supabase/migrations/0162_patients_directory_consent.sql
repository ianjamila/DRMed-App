-- 0162: Patients list — data-privacy consent status.
--
-- Adds `consent_current` and `consent_signed_at` to v_patients_directory so the
-- staff Patients list can show a Consent column and filter to patients with or
-- without consent on file, inside the same paged query (a post-fetch filter
-- would break `count: "exact"` + `.range()`).
--
-- Same body as 0143 plus the two columns, appended at the end (a replace may
-- only add columns after the existing ones). `security_invoker` is restated:
-- `create or replace view` REPLACES reloptions rather than merging them, so
-- omitting it would revert the view to its owner's rights and bypass RLS on
-- patients/visits. hardened-views.test.ts now guards this view. Grants survive
-- a replace; the `authenticated` grant is restated only for readability.

create or replace view public.v_patients_directory
with (security_invoker = true) as
  select
    p.id,
    p.drm_id,
    p.first_name,
    p.middle_name,
    p.last_name,
    p.phone,
    p.email,
    p.pre_registered,
    p.created_at,
    p.referral_source,
    rs.label                       as referral_source_label,
    lv.last_visit_date,
    p.consent_current,
    p.consent_signed_at
  from public.patients p
  left join public.referral_sources rs
    on rs.id = p.referral_source
  left join lateral (
    select max(v.visit_date) as last_visit_date
    from public.visits v
    where v.patient_id = p.id
      and v.deleted_at is null      -- soft delete: never count a deleted visit
  ) lv on true;

comment on view public.v_patients_directory is
  'Patients list backing view: adds referral-source label, last visit date and consent status so all can be sorted, filtered and paged in the query. security_invoker — RLS on patients/visits still applies.';

grant select on public.v_patients_directory to authenticated;
