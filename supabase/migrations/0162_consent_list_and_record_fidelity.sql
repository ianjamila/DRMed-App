-- 0162: Consent — Patients-list status, and consent records that say what
-- was actually agreed to, by whom, and whether it counts.
--
-- Four parts:
--
-- (A) patient_consents.source_form + accepted_statement. A public-form grant
--     (method self_registration) came from /register or /schedule, whose
--     checkboxes carry their OWN one-line statements linking to /privacy —
--     not the clinic consent notice. The staff signed-form page used to render
--     the clinic notice above those grants, which misstates what the patient
--     agreed to. New grants record the form and the exact statement ticked
--     (src/lib/consent/public-form-consent.ts owns the wording; both forms
--     render from the same constants). Existing grants are backfilled from
--     audit evidence only.
--
-- (B) Signer-name snapshot. A self grant stored no name, so the signed form
--     printed the patient's CURRENT name under an old signature — and names
--     can be edited. A BEFORE INSERT trigger now copies the name onto every
--     new self grant, whatever path inserts it (staff pad/paper, portal,
--     public forms). Existing self grants are backfilled only where the
--     patient record provably has not changed since the grant.
--
-- (C) consent_scope. Until now the booking form's checkbox said "processing
--     my contact details to fulfil this booking" — nothing about health
--     information or results — yet it was recorded as full consent. Owner
--     decision 2026-09-24: such a grant is 'booking_contact_only' and no
--     longer counts as consent on file (the patient signs at the counter);
--     the booking form now asks for the same consent as registration, so new
--     booking grants are 'full'. The sync trigger learns the difference and
--     the affected patients are re-synced. Nothing is deleted: the grant row
--     stays, exactly as the patient gave it.
--
-- (D) v_patients_directory gains consent_current / consent_signed_at for the
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
  'Public form a self_registration grant came from (register | schedule). Null for staff/portal grants, and for a historical public grant with no audit evidence of its form.';
comment on column public.patient_consents.accepted_statement is
  'Exact consent statement the patient ticked on a public form. The clinic notice was not shown on those forms.';

-- Backfill from audit evidence, never inference. Each public form writes an
-- audit row in the same request as the grant, carrying consent_recorded:
-- /register → patient.self_registered, /schedule → appointment.booked. A
-- grant takes a form only when exactly one of the two corroborates it within
-- two minutes; none or both leaves source_form null ("form not recorded").
-- (Prod 2026-09-24: all 13 public grants have exactly one, at 0s — 12
-- booking, 1 registration.)
with evidence as (
  select
    c.id,
    bool_or(l.action = 'patient.self_registered') as registered,
    bool_or(l.action = 'appointment.booked')      as booked
  from public.patient_consents c
  join public.audit_log l
    on l.patient_id = c.patient_id
   and l.action in ('patient.self_registered', 'appointment.booked')
   and l.metadata ->> 'consent_recorded' = 'true'
   and l.created_at between c.created_at - interval '2 minutes'
                        and c.created_at + interval '2 minutes'
  where c.method = 'self_registration'
    and c.source_form is null
  group by c.id
)
update public.patient_consents c
set source_form = case when e.registered then 'register' else 'schedule' end
from evidence e
where e.id = c.id
  and e.registered <> e.booked;

-- Both statements were unchanged from before the first public grant
-- (schedule 2026-05-07, register 2026-05-30) until this migration, so they
-- are the words those patients saw. public-form-consent.test.ts pins these
-- literals (register = current wording; schedule = the legacy wording).
update public.patient_consents
set accepted_statement = case source_form
      when 'schedule' then 'Service agreement (required). I consent to drmed.ph processing my contact details to fulfil this booking under the Philippine Data Privacy Act (RA 10173). Lab results are released only after payment. See the Privacy Notice.'
      when 'register' then 'I consent to drmed.ph processing my personal and health information for registration and care under the Philippine Data Privacy Act (RA 10173). See the Privacy Notice.'
    end
where method = 'self_registration'
  and source_form is not null
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

-- Backfill only where the name today is provably the name at signing. The
-- grant's own sync trigger updates the patient row in the grant's transaction,
-- stamping patients.updated_at with exactly the grant's created_at (both are
-- now() of that transaction); any later edit moves it past. So equality —
-- with no grace period — proves the row is unchanged since. Everything else
-- stays null and the signed form says the name is from today's record.
-- Runs BEFORE (C)'s re-sync, which touches the affected patient rows.
update public.patient_consents c
set signatory_name = nullif(concat_ws(' ', p.first_name, p.last_name), '')
from public.patients p
where p.id = c.patient_id
  and c.event_type = 'granted'
  and c.signatory = 'self'
  and c.signatory_name is null
  and p.updated_at = c.created_at;

-- ---------------------------------------------------------------------------
-- (C) Booking-only grants no longer count as consent on file.
-- ---------------------------------------------------------------------------
alter table public.patient_consents
  add column if not exists consent_scope text not null default 'full'
    constraint patient_consents_consent_scope_check
      check (consent_scope in ('full', 'booking_contact_only'));

comment on column public.patient_consents.consent_scope is
  'full = counts as data-privacy consent on file. booking_contact_only = the pre-0162 booking checkbox (contact details for the booking only); recorded but does not set consent_current. Meaningful on granted rows only.';

update public.patient_consents
set consent_scope = 'booking_contact_only'
where method = 'self_registration'
  and source_form = 'schedule'
  and accepted_statement = 'Service agreement (required). I consent to drmed.ph processing my contact details to fulfil this booking under the Philippine Data Privacy Act (RA 10173). Lab results are released only after payment. See the Privacy Notice.';

-- Same function as 0087 (latest event by seq decides), plus: a latest grant
-- that is booking_contact_only leaves the patient with no consent on file —
-- as if never consented, since /schedule records a grant only for a patient
-- it just created (shouldRecordBookingConsent), so there is no earlier full
-- consent to fall back to. Not a withdrawal: consent_withdrawn_at stays null.
create or replace function public.sync_patient_consent_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_latest public.patient_consents%rowtype;
begin
  select * into v_latest
  from public.patient_consents
  where patient_id = new.patient_id
  order by seq desc
  limit 1;

  if v_latest.event_type = 'granted' and v_latest.consent_scope = 'full' then
    update public.patients set
      consent_current = true,
      consent_signed_at = v_latest.created_at,
      consent_withdrawn_at = null,
      consent_method = v_latest.method,
      consent_notice_version = v_latest.notice_version
    where id = new.patient_id;
  elsif v_latest.event_type = 'granted' then
    update public.patients set
      consent_current = false,
      consent_signed_at = null,
      consent_withdrawn_at = null,
      consent_method = null,
      consent_notice_version = null
    where id = new.patient_id;
  else
    update public.patients set
      consent_current = false,
      consent_withdrawn_at = v_latest.created_at
      -- consent_signed_at left as the historical grant time on purpose.
    where id = new.patient_id;
  end if;
  return null;
end;
$$;

revoke execute on function public.sync_patient_consent_state() from public, anon, authenticated;

-- Re-sync the patients whose latest event is now a booking-only grant.
update public.patients p
set consent_current = false,
    consent_signed_at = null,
    consent_withdrawn_at = null,
    consent_method = null,
    consent_notice_version = null
where exists (
  select 1
  from (
    select distinct on (c.patient_id) c.patient_id, c.event_type, c.consent_scope
    from public.patient_consents c
    order by c.patient_id, c.seq desc
  ) latest
  where latest.patient_id = p.id
    and latest.event_type = 'granted'
    and latest.consent_scope = 'booking_contact_only'
);

-- ---------------------------------------------------------------------------
-- (D) Patients list consent status. Same body as 0143 plus two columns
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
