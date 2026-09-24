-- 0162: Consent — Patients-list status, and consent records that say what
-- was actually agreed to and by whom.
--
-- Three parts:
--
-- (A) patient_consents.source_form + accepted_statement. A public-form grant
--     (method self_registration) came from /register or /schedule, whose
--     checkboxes carry their OWN one-line statements linking to /privacy —
--     not the clinic consent notice. The staff signed-form page used to render
--     the clinic notice above those grants, which misstates what the patient
--     agreed to. New grants record the form and the exact statement ticked
--     (src/lib/consent/public-form-consent.ts owns the wording; the forms
--     render from the same constants). Existing grants are backfilled below.
--
-- (B) Signer-name snapshot. A self grant stored no name, so the signed form
--     printed the patient's CURRENT name under an old signature — and names
--     can be edited. A BEFORE INSERT trigger now copies the name onto every
--     new self grant, whatever path inserts it (staff pad/paper, portal,
--     public forms). Existing self grants are backfilled only where the
--     patient record provably has not changed since the grant (see below).
--
-- (C) v_patients_directory gains consent_current / consent_signed_at for the
--     Patients list Consent column + filter (applied inside the paged query).

-- ---------------------------------------------------------------------------
-- (A) Which public form, and the exact statement ticked.
-- ---------------------------------------------------------------------------
alter table public.patient_consents
  add column if not exists source_form text
    constraint patient_consents_source_form_check
      check (source_form in ('register', 'schedule')),
  add column if not exists accepted_statement text;

comment on column public.patient_consents.source_form is
  'Public form a self_registration grant came from (register | schedule). Null for staff/portal grants.';
comment on column public.patient_consents.accepted_statement is
  'Exact consent statement the patient ticked on a public form. The clinic notice was not shown on those forms.';

-- Backfill the existing public-form grants. The grant row never recorded its
-- form, but /schedule creates the patient AND an appointment in the same
-- request, so a new-patient appointment within two minutes of the grant marks
-- a booking; /register makes no appointment. (On prod 2026-09-24: 12 booking,
-- 1 registration.) Both statements are unchanged since before the first
-- public-form grant (schedule 2026-05-07, register 2026-05-30), so today's
-- wording is the wording those patients saw. public-form-consent.test.ts pins
-- these literals to the constants the forms render.
update public.patient_consents c
set source_form = case
      when exists (
        select 1 from public.appointments a
        where a.patient_id = c.patient_id
          and a.created_at between c.created_at - interval '2 minutes'
                               and c.created_at + interval '2 minutes'
      ) then 'schedule'
      else 'register'
    end
where c.method = 'self_registration'
  and c.source_form is null;

update public.patient_consents
set accepted_statement = case source_form
      when 'schedule' then 'Service agreement (required). I consent to drmed.ph processing my contact details to fulfil this booking under the Philippine Data Privacy Act (RA 10173). Lab results are released only after payment. See the Privacy Notice.'
      when 'register' then 'I consent to drmed.ph processing my personal and health information for registration and care under the Philippine Data Privacy Act (RA 10173). See the Privacy Notice.'
    end
where method = 'self_registration'
  and accepted_statement is null;

-- ---------------------------------------------------------------------------
-- (B) Snapshot the signer's name on every new self grant.
-- ---------------------------------------------------------------------------
create or replace function public.snapshot_consent_signer_name()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.event_type = 'granted'
     and new.signatory = 'self'
     and new.signatory_name is null then
    select nullif(concat_ws(' ', p.first_name, p.last_name), '')
      into new.signatory_name
      from public.patients p
     where p.id = new.patient_id;
  end if;
  return new;
end;
$$;

revoke execute on function public.snapshot_consent_signer_name() from public, anon, authenticated;

drop trigger if exists trg_patient_consents_signer_name on public.patient_consents;
create trigger trg_patient_consents_signer_name
  before insert on public.patient_consents
  for each row execute function public.snapshot_consent_signer_name();

-- Backfill only where the name today is provably the name at signing: the
-- grant's own sync trigger bumps patients.updated_at in the same moment, so a
-- record whose updated_at is no later than the grant (5s slack for the
-- separate-statement public forms) has not been edited since. Anything else
-- stays null and the signed form says the name is from today's record.
update public.patient_consents c
set signatory_name = nullif(concat_ws(' ', p.first_name, p.last_name), '')
from public.patients p
where p.id = c.patient_id
  and c.event_type = 'granted'
  and c.signatory = 'self'
  and c.signatory_name is null
  and p.updated_at <= c.created_at + interval '5 seconds';

-- ---------------------------------------------------------------------------
-- (C) Patients list consent status. Same body as 0143 plus two columns
-- appended at the end (a replace may only add columns after the existing
-- ones). security_invoker is restated: create or replace view REPLACES
-- reloptions, so omitting it would run the view with its owner's rights and
-- bypass RLS on patients/visits (hardened-views.test.ts guards this). Grants
-- survive a replace; the authenticated grant is restated for readability.
-- ---------------------------------------------------------------------------
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
