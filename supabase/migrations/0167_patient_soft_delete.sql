-- =============================================================================
-- 0167_patient_soft_delete.sql — patient soft delete, restore, active-patient rule
-- =============================================================================
-- Spec: docs/superpowers/specs/2026-09-24-patient-delete-design.md (rollout PR 2).
--
-- Admins may delete a patient record, with a reason, only while nothing is open
-- (appointments, unfinished work, unpaid money, open HMO claims). Nothing is
-- removed: the row gains deleted_at/by/reason/note and disappears from the
-- directory, pickers, matching, the portal and patient notifications; visits,
-- payments, results and reports keep it. Restore clears the four fields.
--
-- Who may change the lifecycle fields: ONLY delete_patient/restore_patient,
-- owned by the private NOLOGIN role patient_lifecycle_writer and checked by a
-- SECURITY INVOKER trigger on current_user. No GUC, JWT or service-role UPDATE
-- can set them (0125's guards validate transitions; they authorize nothing).
--
-- Written to be re-runnable during local development: every object is created
-- with if-not-exists / drop-if-exists / create-or-replace.
--
-- P-codes: P0057 unauthorized lifecycle write, P0058 inactive patient,
-- P0059 open blockers (JSON in DETAIL), P0060 invalid deletion metadata,
-- P0061 invalid restore state. Translations: src/lib/accounting/pg-errors.ts.
--
-- ORDER ON PROD: 0162 (feat/consent-extras) must be applied BEFORE this file —
-- it re-creates v_patients_directory without the active predicate.

-- ---------------------------------------------------------------------------
-- (1) The private writer role.
-- ---------------------------------------------------------------------------
do $role$
begin
  if not exists (select 1 from pg_roles where rolname = 'patient_lifecycle_writer') then
    create role patient_lifecycle_writer nologin noinherit nobypassrls;
  end if;
end
$role$;

-- Re-assert attributes on every run (not just at creation) so a later manual
-- ALTER ROLE elsewhere can never quietly leave this role loginable/inheriting/
-- RLS-bypassing without this migration re-stating the correct values.
alter role patient_lifecycle_writer nologin noinherit nobypassrls;

-- The migration owner needs SET to hand function ownership over (PG16+) and
-- INHERIT to re-run create-or-replace on those functions in later migrations.
-- postgres already owns every table this role can touch, so inheriting its
-- narrower privileges grants postgres nothing new. No runtime role is ever a
-- member (asserted by the smoke test).
grant patient_lifecycle_writer to postgres with inherit true, set true;
revoke patient_lifecycle_writer from anon, authenticated, service_role, authenticator;

grant usage on schema public to patient_lifecycle_writer;

-- ---------------------------------------------------------------------------
-- (2) Lifecycle columns and row checks.
-- ---------------------------------------------------------------------------
alter table public.patients
  add column if not exists deleted_at    timestamptz,
  add column if not exists deleted_by    uuid,
  add column if not exists delete_reason text,
  add column if not exists delete_note   text;

comment on column public.patients.deleted_at is
  'Soft delete (0167). Set only by delete_patient(); cleared only by restore_patient().';
comment on column public.patients.delete_reason is
  'duplicate | test_record | patient_request | other (other requires delete_note).';

-- Restrictive: deleting a staff profile must never erase who deleted a patient.
alter table public.patients drop constraint if exists patients_deleted_by_fkey;
alter table public.patients
  add constraint patients_deleted_by_fkey
  foreign key (deleted_by) references public.staff_profiles(id) on delete restrict;

alter table public.patients drop constraint if exists patients_deletion_fields_check;
alter table public.patients
  add constraint patients_deletion_fields_check check (
    (deleted_at is null and deleted_by is null and delete_reason is null and delete_note is null)
    or (
      deleted_at is not null
      and deleted_by is not null
      and delete_reason in ('duplicate', 'test_record', 'patient_request', 'other')
      and (delete_note is null
           or (delete_note = btrim(delete_note) and length(delete_note) between 1 and 500))
      and (delete_reason <> 'other' or delete_note is not null)
    )
  );

alter table public.patients drop constraint if exists patients_not_deleted_and_merged;
alter table public.patients
  add constraint patients_not_deleted_and_merged
  check (deleted_at is null or merged_into_id is null);

-- Active-directory reads and the Deleted Patients list.
create index if not exists idx_patients_active
  on public.patients (id)
  where deleted_at is null and merged_into_id is null;
create index if not exists idx_patients_deleted
  on public.patients (deleted_at desc, id)
  where deleted_at is not null;

-- ---------------------------------------------------------------------------
-- (3) What the writer role may touch — nothing else.
-- ---------------------------------------------------------------------------
grant select on public.patients to patient_lifecycle_writer;
grant update (deleted_at, deleted_by, delete_reason, delete_note)
  on public.patients to patient_lifecycle_writer;
grant select on public.staff_profiles to patient_lifecycle_writer;
grant insert on public.audit_log to patient_lifecycle_writer;
grant usage on sequence public.audit_log_id_seq to patient_lifecycle_writer;

drop policy if exists "patients: lifecycle writer select" on public.patients;
create policy "patients: lifecycle writer select" on public.patients
  for select to patient_lifecycle_writer using (true);
drop policy if exists "patients: lifecycle writer update" on public.patients;
create policy "patients: lifecycle writer update" on public.patients
  for update to patient_lifecycle_writer using (true) with check (true);
drop policy if exists "staff_profiles: lifecycle writer select" on public.staff_profiles;
create policy "staff_profiles: lifecycle writer select" on public.staff_profiles
  for select to patient_lifecycle_writer using (true);
drop policy if exists "audit_log: lifecycle writer insert" on public.audit_log;
create policy "audit_log: lifecycle writer insert" on public.audit_log
  for insert to patient_lifecycle_writer
  with check (action in ('patient.deleted', 'patient.restored'));

-- ---------------------------------------------------------------------------
-- (4) The guard. SECURITY INVOKER so current_user is the role actually
-- writing — the delete/restore functions run as patient_lifecycle_writer.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_patient_lifecycle()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  -- Columns a BEFORE UPDATE trigger elsewhere may legitimately touch as a
  -- side effect of any update, independent of what this guard is checking.
  -- 'row_version' does not exist on main yet: 0170 (sheet-sync, in flight)
  -- adds it with trg_patients_referral_origin, which bumps it on every UPDATE.
  -- BEFORE triggers fire in name order (lifecycle_guard before
  -- referral_origin), but that ordering must not be load-bearing —
  -- `jsonb - text[]` ignores missing keys, so listing 'row_version' here is
  -- safe before 0170 lands.
  k_bookkeeping constant text[] :=
    array['deleted_at', 'deleted_by', 'delete_reason', 'delete_note', 'updated_at', 'row_version'];
  v_lifecycle_changed boolean;
  v_other_changed boolean;
begin
  if tg_op = 'INSERT' then
    if new.deleted_at is not null or new.deleted_by is not null
       or new.delete_reason is not null or new.delete_note is not null then
      raise exception 'a patient record cannot be created already deleted'
        using errcode = 'P0057';
    end if;
    return new;
  end if;

  v_lifecycle_changed :=
    (new.deleted_at, new.deleted_by, new.delete_reason, new.delete_note)
      is distinct from (old.deleted_at, old.deleted_by, old.delete_reason, old.delete_note);
  v_other_changed := (to_jsonb(new) - k_bookkeeping) is distinct from (to_jsonb(old) - k_bookkeeping);

  if v_lifecycle_changed then
    if current_user <> 'patient_lifecycle_writer' then
      raise exception 'only delete_patient / restore_patient can delete or restore a patient'
        using errcode = 'P0057';
    end if;
    if v_other_changed then
      raise exception 'deleting or restoring a patient cannot change any other field'
        using errcode = 'P0057';
    end if;
    -- Only a genuine RESTORE (deleted_at not null -> null) may touch the
    -- lifecycle fields of an already-deleted row. Without this, the writer
    -- could silently overwrite who deleted a record, when, or why, on a row
    -- that is already deleted (re-running delete_patient, or a direct writer
    -- UPDATE, on a deleted patient).
    if old.deleted_at is not null and new.deleted_at is not null then
      raise exception 'patient % is already deleted — restore it before recording a new deletion', old.drm_id
        using errcode = 'P0058';
    end if;
    return new;
  end if;

  if old.deleted_at is not null and v_other_changed then
    raise exception 'patient % is deleted — restore the record before changing it', old.drm_id
      using errcode = 'P0058';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_patient_lifecycle() from public, anon, authenticated, service_role;

drop trigger if exists trg_patients_lifecycle_guard on public.patients;
create trigger trg_patients_lifecycle_guard
  before insert or update on public.patients
  for each row execute function public.enforce_patient_lifecycle();

-- ---------------------------------------------------------------------------
-- (5) Kept history — what stays on file. Display enrichment only: the delete
-- dialog, the audit row, the Deleted Patients page. Counts what the patient
-- page shows (live visits, non-voided payments on them) plus every
-- appointment and consent event. SECURITY DEFINER so the service-only consent
-- ledger (0086) is counted rather than silently read as zero through RLS.
-- ---------------------------------------------------------------------------
create or replace function public.patient_kept_counts(p_patient_ids uuid[])
returns table (patient_id uuid, visits bigint, payments bigint, appointments bigint, consents bigint)
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select
    p.id,
    (select count(*) from public.visits v
      where v.patient_id = p.id and v.deleted_at is null),
    (select count(*) from public.payments pay
       join public.visits v on v.id = pay.visit_id
      where v.patient_id = p.id and v.deleted_at is null and pay.voided_at is null),
    (select count(*) from public.appointments a where a.patient_id = p.id),
    (select count(*) from public.patient_consents c where c.patient_id = p.id)
  from public.patients p
  where p.id = any(p_patient_ids)
  order by p.id;
$$;

revoke all on function public.patient_kept_counts(uuid[]) from public, anon, authenticated;
grant execute on function public.patient_kept_counts(uuid[]) to service_role, patient_lifecycle_writer;

-- ---------------------------------------------------------------------------
-- (6) What stops a deletion. The single authority: the delete dialog shows
-- this list and delete_patient() re-runs it under the patient lock.
-- Returns a deterministic JSON array of
--   {kind, resource_id, visit_id, label, amount_php, href}
-- deduplicated by (kind, resource_id). kinds (pinned in deletion.test.ts):
--   appointment, clinical, empty_visit, balance, hmo_patient_share,
--   hmo_reconciliation, hmo_claim, hmo_unbilled
-- Owner-approved rules: docs/superpowers/specs/2026-09-24-patient-delete-design.md
-- "Blockers: exact database rules". Money in SQL numeric, never float.
-- VOLATILE: each call reads a fresh READ COMMITTED snapshot after the caller's lock.
-- ---------------------------------------------------------------------------
create or replace function public.patient_delete_blockers(p_patient_id uuid)
returns jsonb
language sql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
with
bounds as (
  -- Today's Manila midnight as an instant. Not now(): an appointment earlier
  -- today still blocks. Not current_date: that is the UTC day.
  select date_trunc('day', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila' as manila_today
),
pat as (
  select p.drm_id from public.patients p where p.id = p_patient_id
),
live_visits as (
  select v.id, v.visit_number, v.payment_status, v.total_php, v.paid_php,
         v.hmo_provider_id, v.created_at
    from public.visits v
   where v.patient_id = p_patient_id
     and v.deleted_at is null
),
-- Billable lines of live HMO visits: package headers and plain lines, never
-- components (a package is priced on its header), never cancelled lines.
hmo_lines as (
  select tr.id as tr_id, v.id as visit_id, v.visit_number, v.payment_status,
         tr.final_price_php, tr.hmo_approved_amount_php,
         ci.id as item_id, ci.billed_amount_php, ci.patient_billed_amount_php
    from live_visits v
    join public.test_requests tr on tr.visit_id = v.id
    -- At most one live claim item per line (idx_hmo_claim_items_one_active_per_tr).
    left join public.hmo_claim_items ci
      on ci.test_request_id = tr.id and not ci.batch_voided
   where v.hmo_provider_id is not null
     and tr.deleted_at is null
     and tr.parent_id is null
     and tr.status <> 'cancelled'
),
-- Every live claim item on ANY line of this patient, deleted or not: a
-- receivable must never drop out through an operational filter (0147).
claim_items as (
  select ci.id, ci.batch_id, ci.billed_amount_php, ci.paid_amount_php,
         ci.patient_billed_amount_php, ci.written_off_amount_php,
         ci.billed_amount_php - ci.paid_amount_php - ci.patient_billed_amount_php
           - ci.written_off_amount_php as unresolved,
         tr.visit_id, v.visit_number,
         b.status as batch_status, b.voided_at as batch_voided_at
    from public.hmo_claim_items ci
    join public.test_requests tr on tr.id = ci.test_request_id
    join public.visits v on v.id = tr.visit_id
    join public.hmo_claim_batches b on b.id = ci.batch_id
   where v.patient_id = p_patient_id
     and not ci.batch_voided
),
recon as (
  -- (a) An HMO line whose money cannot be worked out: no price snapshot, or
  -- a claim that disagrees with the approved amount. An unclaimed line with
  -- NO hmo_approved_amount_php recorded is deliberately NOT flagged here
  -- (see share_parts below): 0133 already releases an HMO visit without a
  -- counter payment, and there is no UI path to record
  -- hmo_approved_amount_php on a lab line before a claim exists, so
  -- treating "never recorded" as a reconciliation problem would have
  -- permanently blocked 443 of 925 HMO patients in prod (2026-09-25 review).
  select 'hmo_reconciliation'::text as kind, l.tr_id as resource_id, l.visit_id,
         case
           when l.final_price_php is null
             then 'Visit ' || l.visit_number || ': a line has no price on file'
           else 'Visit ' || l.visit_number || ': the HMO claim amount does not match the approved amount'
         end as label,
         null::numeric as amount_php,
         '/staff/visits/' || l.visit_id as href
    from hmo_lines l
   where l.final_price_php is null
      or (l.item_id is not null and l.hmo_approved_amount_php is not null
          and l.billed_amount_php <> l.hmo_approved_amount_php)
  union all
  -- (b) A live claim line on a batch that says it is voided.
  select 'hmo_reconciliation'::text, c.id, c.visit_id,
         'Visit ' || c.visit_number || ': a claim line is still active on a voided batch',
         null::numeric, '/staff/admin/accounting/hmo-claims/batches/' || c.batch_id
    from claim_items c
   where c.batch_voided_at is not null or c.batch_status = 'voided'
  union all
  -- (c) A live allocation pointing at a voided payment or another visit's payment.
  select 'hmo_reconciliation'::text, al.id, c.visit_id,
         'Visit ' || c.visit_number || ': an HMO payment allocation points at a voided or mismatched payment',
         al.amount_php, '/staff/admin/accounting/hmo-claims/batches/' || c.batch_id
    from public.hmo_payment_allocations al
    join claim_items c on c.id = al.item_id
    join public.payments pay on pay.id = al.payment_id
   where al.voided_at is null
     and (pay.voided_at is not null or pay.visit_id <> c.visit_id)
  union all
  -- (d) An insurer payment (method 'hmo') whose live allocations do not add
  -- up to it — a half-recorded settlement is not proof of a settled claim.
  select 'hmo_reconciliation'::text, pay.id, pay.visit_id,
         'Visit ' || v.visit_number || ': an HMO payment is not fully matched to claim lines',
         pay.amount_php, '/staff/visits/' || pay.visit_id
    from public.payments pay
    join public.visits v on v.id = pay.visit_id
   where v.patient_id = p_patient_id
     and pay.method = 'hmo'
     and pay.voided_at is null
     and pay.amount_php <> coalesce((
       select sum(al.amount_php) from public.hmo_payment_allocations al
        where al.payment_id = pay.id and al.voided_at is null), 0)
),
-- Patient principal per live HMO visit, built from two kinds of rows so a
-- claim-to-patient transfer survives its own line being queue-deleted
-- afterwards (2026-09-25 review):
--   (i)  one row per live line with no open reconciliation problem: the
--        coverage gap max(price − insurer coverage, 0), skipped when the
--        visit is waived. Coverage = the live claim's billed amount once
--        billed, else the explicit approved amount, else — both NULL, an
--        unclaimed line with no coverage decision recorded — the line's
--        own price, via an explicit coalesce rather than relying on
--        greatest(NULL, 0): 0133 treats an unrecorded HMO line as fully
--        covered by the insurer, so this line contributes 0.
--   (ii) one row per LIVE claim item, whether its line OR its visit is
--        deleted or not (claim_items already spans deleted lines, per
--        0147, and this join is against public.visits — see the
--        hmo_patient_share branch below): the amount already transferred
--        to the patient. Sourced ONLY here, never from hmo_lines, so a
--        transfer is never double-counted — a package component could in
--        principle carry its own claim item, but there is only this one
--        source for the transfer amount, so nothing else could double it.
--        Waiver never clears a transfer.
share_parts as (
  select l.visit_id,
         case when l.payment_status = 'waived' then 0
              else greatest(l.final_price_php
                            - coalesce(l.billed_amount_php, l.hmo_approved_amount_php, l.final_price_php), 0)
         end as amt
    from hmo_lines l
   where not exists (
     select 1 from recon r where r.visit_id = l.visit_id and r.resource_id = l.tr_id
   )
  union all
  select c.visit_id, c.patient_billed_amount_php as amt
    from claim_items c
   where c.patient_billed_amount_php > 0
),
share as (
  select visit_id, sum(amt) as principal
    from share_parts
   group by visit_id
),
-- The patient's own payments on that visit. Insurer settlements (method 'hmo')
-- are already counted once, through the claim's paid amount.
patient_paid as (
  select pay.visit_id, sum(pay.amount_php) as paid
    from public.payments pay
   where pay.visit_id in (select s.visit_id from share s)
     and pay.voided_at is null
     and pay.method is distinct from 'hmo'
   group by pay.visit_id
),
blockers as (
  select 1 as rank, 'appointment'::text as kind, a.id as resource_id, null::uuid as visit_id,
         case when a.status = 'pending_callback'
           then 'Callback request'
                || coalesce(' for ' || to_char(a.scheduled_at at time zone 'Asia/Manila', 'FMMon FMDD, YYYY'), '')
                || ' is still open'
           -- Never pass a NULL scheduled_at into to_char (renders NULL, not
           -- an error, silently nulling the whole label).
           when a.scheduled_at is null
             then initcap(a.status) || ' walk-in request (no date) is still open'
           else initcap(a.status) || ' appointment on '
                || to_char(a.scheduled_at at time zone 'Asia/Manila', 'FMMon FMDD, YYYY FMHH12:MI AM')
         end as label,
         null::numeric as amount_php,
         '/staff/appointments?q=' || (select drm_id from pat) as href,
         coalesce(a.scheduled_at, a.created_at) as sort_at
    from public.appointments a
   cross join bounds b
   where a.patient_id = p_patient_id
     and (a.status = 'pending_callback'
          or (a.status in ('confirmed', 'arrived') and a.scheduled_at >= b.manila_today)
          -- Online lab-request bookings insert 'confirmed' with scheduled_at
          -- NULL (src/lib/appointments/create.ts ~248), and the appointments
          -- page treats a NULL-dated confirmed/arrived row as open forever —
          -- 30 prod patients (2026-09-25 review).
          or (a.status in ('confirmed', 'arrived') and a.scheduled_at is null))
  union all
  select 2, 'clinical'::text, tr.id, v.id,
         coalesce(s.name, 'A line') || ' on visit ' || v.visit_number || ' is '
           || replace(tr.status, '_', ' '),
         null::numeric, '/staff/visits/' || v.id, tr.requested_at
    from live_visits v
    join public.test_requests tr on tr.visit_id = v.id
    left join public.services s on s.id = tr.service_id
   where tr.deleted_at is null
     and tr.status not in ('released', 'cancelled')
  union all
  select 2, 'empty_visit'::text, v.id, v.id,
         'Visit ' || v.visit_number || ' has nothing on it yet — finish it or remove it from the queue',
         null::numeric, '/staff/visits/' || v.id, v.created_at
    from live_visits v
   where not exists (
     select 1 from public.test_requests tr where tr.visit_id = v.id and tr.deleted_at is null
   )
  union all
  select 3, 'balance'::text, v.id, v.id,
         'Visit ' || v.visit_number || ' is ' || v.payment_status || ': ₱'
           || to_char(greatest(v.total_php - v.paid_php, 0), 'FM999,999,990.00') || ' unpaid',
         greatest(v.total_php - v.paid_php, 0), '/staff/visits/' || v.id, v.created_at
    from live_visits v
   where v.hmo_provider_id is null
     and v.payment_status in ('unpaid', 'partial')
     -- Historical import: 4,147 prod visits carry total_php = 0 and
     -- payment_status 'unpaid' forever (recalc only runs on a payment
     -- insert/void, and these never had one) — exclude anything that does
     -- not actually owe money, so this label can never read "₱0.00 unpaid"
     -- (2026-09-25 prod-count review).
     and v.total_php > v.paid_php
  union all
  select 3, 'hmo_patient_share'::text, s.visit_id, s.visit_id,
         'Visit ' || v.visit_number || ': the patient''s share of ₱'
           || to_char(s.principal - coalesce(pp.paid, 0), 'FM999,999,990.00') || ' is unpaid',
         s.principal - coalesce(pp.paid, 0), '/staff/visits/' || s.visit_id, v.created_at
    from share s
    -- NOT live_visits: a claim-to-patient transfer must survive its own
    -- VISIT being (wrongly) soft-deleted too, not just its line — every
    -- visit_id in `share` already belongs to this patient (via hmo_lines /
    -- claim_items, both scoped by p_patient_id), so this join needs no
    -- extra filter (2026-09-25 re-review).
    join public.visits v on v.id = s.visit_id
    left join patient_paid pp on pp.visit_id = s.visit_id
   where s.principal - coalesce(pp.paid, 0) > 0
  union all
  select 4, r.kind, r.resource_id, r.visit_id, r.label, r.amount_php, r.href, null::timestamptz
    from recon r
  union all
  select 5, 'hmo_claim'::text, c.id, c.visit_id,
         'Visit ' || c.visit_number || ': ₱' || to_char(c.unresolved, 'FM999,999,990.00')
           || ' of an HMO claim is not settled',
         c.unresolved, '/staff/admin/accounting/hmo-claims/batches/' || c.batch_id, null::timestamptz
    from claim_items c
   where c.unresolved > 0
  union all
  select 5, 'hmo_unbilled'::text, l.tr_id, l.visit_id,
         'Visit ' || l.visit_number || ': ₱' || to_char(l.hmo_approved_amount_php, 'FM999,999,990.00')
           || ' of approved HMO coverage has not been claimed',
         l.hmo_approved_amount_php, '/staff/visits/' || l.visit_id, null::timestamptz
    from hmo_lines l
   where l.item_id is null
     and coalesce(l.hmo_approved_amount_php, 0) > 0
),
deduped as (
  select distinct on (kind, resource_id) *
    from blockers
   order by kind, resource_id, rank
)
select coalesce(
  jsonb_agg(
    jsonb_build_object(
      'kind', kind, 'resource_id', resource_id, 'visit_id', visit_id,
      'label', label, 'amount_php', amount_php, 'href', href)
    order by rank, sort_at nulls last, kind, resource_id),
  '[]'::jsonb)
from deduped;
$$;

revoke all on function public.patient_delete_blockers(uuid) from public, anon, authenticated;
grant execute on function public.patient_delete_blockers(uuid) to service_role, patient_lifecycle_writer;

-- ---------------------------------------------------------------------------
-- (7) Delete and restore. Owned by patient_lifecycle_writer (the guard's only
-- accepted current_user). service_role-only EXECUTE; the server action passes
-- the admin's id from requireAdminStaff(), never from form input, and the
-- request IP/UA as p_context (only those two keys). The audit row is written
-- here, inside the same transaction: if it fails, nothing changes.
-- Lock protocol (shared with PR 3's writers): transaction advisory lock on
-- (hashtext('patient_lifecycle'), hashtext(id)), then FOR UPDATE on the row,
-- then a fresh read of blockers.
-- Known window until PR 3: inserts of lines/payments/claim items on an
-- existing live visit take no lock on the patient and can land between the
-- blocker check and the UPDATE; a visit insert waiting on the key-share lock
-- succeeds after the delete commits. PR 3 contract: every writer takes
-- pg_advisory_xact_lock_shared(hashtext('patient_lifecycle'),
-- hashtext(p_patient_id::text)) FIRST (visit resolved to patient), then
-- re-checks deleted_at; taking it after a key-share lock risks deadlock.
-- delete_patient checks deleted_at/merged_into_id itself (P0058) BEFORE the
-- UPDATE, so re-deleting an already-deleted (or merged) row fails early with
-- a clear error rather than relying on the guard trigger's own P0058 for
-- "re-setting deletion metadata on an already-deleted row" (part 4 above).
-- ---------------------------------------------------------------------------
create or replace function public.delete_patient(
  p_patient_id uuid, p_reason text, p_note text, p_actor uuid, p_context jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_note     text := nullif(btrim(coalesce(p_note, '')), '');
  v_ip       inet;
  v_patient  record;
  v_blockers jsonb;
  v_kept     jsonb;
begin
  if p_actor is null or not exists (
    select 1 from public.staff_profiles s
     where s.id = p_actor and s.role = 'admin' and s.is_active and s.deleted_at is null
  ) then
    raise exception 'only an active admin can delete a patient record' using errcode = 'P0057';
  end if;

  if p_reason is null or p_reason not in ('duplicate', 'test_record', 'patient_request', 'other') then
    raise exception 'choose a reason: duplicate, test record, requested by patient, or other'
      using errcode = 'P0060';
  end if;
  if p_reason = 'other' and v_note is null then
    raise exception 'add a note when the reason is Other' using errcode = 'P0060';
  end if;
  if v_note is not null and length(v_note) > 500 then
    raise exception 'the note can be at most 500 characters' using errcode = 'P0060';
  end if;
  if p_context is not null and (
       jsonb_typeof(p_context) <> 'object'
       or exists (select 1 from jsonb_object_keys(p_context) k where k not in ('ip', 'user_agent'))
     ) then
    raise exception 'unexpected audit context' using errcode = 'P0060';
  end if;
  begin
    v_ip := nullif(p_context->>'ip', '')::inet;
  exception when invalid_text_representation then
    v_ip := null;
  end;

  -- Exclusive advisory lock on this patient. PR 3's writers take this SAME
  -- key SHARED, first (see the lock contract above), before touching the row.
  perform pg_advisory_xact_lock(hashtext('patient_lifecycle'), hashtext(p_patient_id::text));
  select p.id, p.drm_id, p.deleted_at, p.merged_into_id into v_patient
    from public.patients p where p.id = p_patient_id
     for update;
  if not found or v_patient.deleted_at is not null or v_patient.merged_into_id is not null then
    raise exception 'this patient record is not active (already deleted, merged or missing)'
      using errcode = 'P0058';
  end if;

  v_blockers := public.patient_delete_blockers(p_patient_id);
  if jsonb_array_length(v_blockers) > 0 then
    raise exception 'this patient still has open items' using
      errcode = 'P0059', detail = v_blockers::text;
  end if;

  select to_jsonb(k) - 'patient_id' into v_kept
    from public.patient_kept_counts(array[p_patient_id]) k;

  update public.patients
     set deleted_at = now(), deleted_by = p_actor, delete_reason = p_reason, delete_note = v_note
   where id = p_patient_id;

  insert into public.audit_log (actor_id, actor_type, patient_id, action, resource_type, resource_id,
                                metadata, ip_address, user_agent)
  values (p_actor, 'staff', p_patient_id, 'patient.deleted', 'patient', p_patient_id,
          jsonb_build_object('drm_id', v_patient.drm_id, 'reason', p_reason, 'note', v_note, 'kept', v_kept),
          v_ip, left(nullif(p_context->>'user_agent', ''), 512));

  return jsonb_build_object('patient_id', p_patient_id, 'drm_id', v_patient.drm_id, 'kept', v_kept);
end;
$$;

create or replace function public.restore_patient(p_patient_id uuid, p_actor uuid, p_context jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_ip      inet;
  v_patient record;
  v_kept    jsonb;
begin
  if p_actor is null or not exists (
    select 1 from public.staff_profiles s
     where s.id = p_actor and s.role = 'admin' and s.is_active and s.deleted_at is null
  ) then
    raise exception 'only an active admin can restore a patient record' using errcode = 'P0057';
  end if;
  if p_context is not null and (
       jsonb_typeof(p_context) <> 'object'
       or exists (select 1 from jsonb_object_keys(p_context) k where k not in ('ip', 'user_agent'))
     ) then
    raise exception 'unexpected audit context' using errcode = 'P0060';
  end if;
  begin
    v_ip := nullif(p_context->>'ip', '')::inet;
  exception when invalid_text_representation then
    v_ip := null;
  end;

  perform pg_advisory_xact_lock(hashtext('patient_lifecycle'), hashtext(p_patient_id::text));
  select p.id, p.drm_id, p.deleted_at, p.delete_reason, p.delete_note, p.merged_into_id into v_patient
    from public.patients p where p.id = p_patient_id
     for update;
  if not found then
    raise exception 'patient record not found' using errcode = 'P0058';
  end if;
  if v_patient.deleted_at is null or v_patient.merged_into_id is not null then
    raise exception 'this patient record is not deleted, so there is nothing to restore'
      using errcode = 'P0061';
  end if;

  select to_jsonb(k) - 'patient_id' into v_kept
    from public.patient_kept_counts(array[p_patient_id]) k;

  update public.patients
     set deleted_at = null, deleted_by = null, delete_reason = null, delete_note = null
   where id = p_patient_id;

  insert into public.audit_log (actor_id, actor_type, patient_id, action, resource_type, resource_id,
                                metadata, ip_address, user_agent)
  values (p_actor, 'staff', p_patient_id, 'patient.restored', 'patient', p_patient_id,
          jsonb_build_object('drm_id', v_patient.drm_id,
                             'previous_reason', v_patient.delete_reason,
                             'previous_note', v_patient.delete_note,
                             'deleted_at', v_patient.deleted_at,
                             'kept', v_kept),
          v_ip, left(nullif(p_context->>'user_agent', ''), 512));

  return jsonb_build_object('patient_id', p_patient_id, 'drm_id', v_patient.drm_id, 'kept', v_kept);
end;
$$;

-- PG17: ALTER FUNCTION … OWNER TO <role> needs CREATE on the schema for the
-- NEW owner at transfer time (controller-notes.md, Task 1 spike). Grant it
-- only for the transfer, then revoke — the role has no lasting need for it
-- and the smoke test's ACL assertions (s1) depend on it staying revoked.
grant create on schema public to patient_lifecycle_writer;
alter function public.delete_patient(uuid, text, text, uuid, jsonb) owner to patient_lifecycle_writer;
alter function public.restore_patient(uuid, uuid, jsonb) owner to patient_lifecycle_writer;
revoke create on schema public from patient_lifecycle_writer;

revoke all on function public.delete_patient(uuid, text, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.restore_patient(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.delete_patient(uuid, text, text, uuid, jsonb) to service_role;
grant execute on function public.restore_patient(uuid, uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- (8) The portal identity helper returns a patient ONLY while that record is
-- active. Every patient RLS policy (0114/0151) calls it, so an already-issued
-- portal JWT for a deleted or merged record reads nothing — without touching
-- staff policies. No merge-following. SECURITY DEFINER owned by the migration
-- owner, which owns patients and is not subject to its RLS (no FORCE), so the
-- lookup cannot recurse into "patients: patient self select". Takes no
-- argument, so it cannot be used to probe arbitrary ids.
-- ---------------------------------------------------------------------------
create or replace function public.current_patient_id()
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select p.id
    from public.patients p
   where p.id = coalesce(
           nullif(current_setting('app.current_patient_id', true), '')::uuid,
           nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'patient_id', '')::uuid)
     and p.deleted_at is null
     and p.merged_into_id is null;
$$;

-- Must stay executable by every role whose policies call it (drmed-migrations).
revoke all on function public.current_patient_id() from public;
grant execute on function public.current_patient_id() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- (9) Views. One active rule for every directory surface: not deleted, not
-- merged (merged tombstones used to leak into the staff list). History reads
-- (visits, receipts, reports) join patients directly and are NOT filtered.
-- create or replace view REPLACES reloptions, so security_invoker is restated
-- on every one (hardened-views.test.ts). Grants survive a replace; they are
-- restated anyway, after revoking the blanket defaults.
-- ---------------------------------------------------------------------------

-- Patients list. Column list = 0162's (consent columns LAST); this file only
-- adds the WHERE. 0162 must reach prod before this migration.
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
  ) lv on true
  where p.deleted_at is null
    and p.merged_into_id is null;

comment on view public.v_patients_directory is
  'Patients list: ACTIVE patients only (not deleted, not merged — 0167), with referral-source label, last visit date and consent status. security_invoker — RLS on patients/visits still applies.';

-- ACL as 0171 left it (authenticated SELECT only); restated, never widened.
revoke all on public.v_patients_directory from public, anon, authenticated;
grant select on public.v_patients_directory to authenticated;

-- Admin-only inclusive source: the same directory plus deleted rows and who
-- deleted them. Merged rows stay out. Non-admins get zero rows (not an error)
-- because of the has_role predicate; service_role gets no grant — read it with
-- the RLS staff client after requireAdminStaff().
create or replace view public.v_patients_directory_admin
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
    p.consent_signed_at,
    p.deleted_at,
    p.deleted_by,
    sp.full_name                   as deleted_by_name,
    p.delete_reason,
    p.delete_note
  from public.patients p
  left join public.referral_sources rs
    on rs.id = p.referral_source
  left join public.staff_profiles sp
    on sp.id = p.deleted_by
  left join lateral (
    select max(v.visit_date) as last_visit_date
    from public.visits v
    where v.patient_id = p.id
      and v.deleted_at is null
  ) lv on true
  where p.merged_into_id is null
    and (select public.has_role(array['admin']));

comment on view public.v_patients_directory_admin is
  'Admin-only patients source that INCLUDES deleted records (Admin Tools › Deleted Patients; PR 4 Show deleted). Excludes merged. Zero rows for non-admins. security_invoker.';

revoke all on public.v_patients_directory_admin from public, anon, authenticated, service_role;
grant select on public.v_patients_directory_admin to authenticated;

-- Duplicate candidates: both sides active. Every caller uses the admin client.
create or replace view public.v_patient_dedup_candidate_pairs
with (security_invoker = true) as
with active as (
  select id, drm_id, first_name, last_name, middle_name, birthdate, email,
         phone_normalized, address, sex,
         (legacy_import_run_id is not null) as is_legacy, created_at
  from public.patients
  where merged_into_id is null
    and deleted_at is null
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

revoke all on public.v_patient_dedup_candidate_pairs from public, anon, authenticated;
grant select on public.v_patient_dedup_candidate_pairs to service_role;

-- Consent worklist: body of 0150, plus the deleted_at predicate.
create or replace view public.v_patients_without_consent
with (security_invoker = true) as
select
  p.id,
  p.drm_id,
  p.first_name,
  p.last_name,
  p.phone,
  p.email,
  p.pre_registered,
  nullif(concat_ws(', ', n.last_name, n.first_name), '') as patient_name,
  (case when coalesce(p.phone, '') <> '' then 1 else 0 end
   + case when coalesce(p.email, '') <> '' then 1 else 0 end) as contact_score,
  coalesce(v.visit_count, 0::bigint) as visit_count,
  v.last_visit_at
from public.patients p
cross join lateral (
  select
    nullif(btrim(p.last_name, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'), '') as last_name,
    nullif(btrim(p.first_name, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'), '') as first_name
) n
left join (
  select
    patient_id,
    count(*) as visit_count,
    max(visit_date) as last_visit_at
  from public.visits
  where deleted_at is null
  group by patient_id
) v on v.patient_id = p.id
where p.consent_current = false
  and p.merged_into_id is null
  and p.deleted_at is null;

comment on view public.v_patients_without_consent is
  'Active patients (not merged, not deleted — 0167) lacking current consent, with live visit count and last Manila visit date. Invoker RLS; shared by the admin report and CSV.';

revoke all on public.v_patients_without_consent from public, anon, authenticated;
grant select on public.v_patients_without_consent to authenticated;

-- ---------------------------------------------------------------------------
-- (10) Booking/registration identity match: ACTIVE rows only. A deleted or
-- merged identity booking again gets a fresh DRM-ID (owner decision); staff
-- can restore + merge if it was the same person. Body = 0158 plus the two
-- predicates; the identity lock stays first. PR 3 adds the lifecycle lock and
-- the post-lock re-read. search_path kept as `public` (0158's own value, not
-- pg_catalog/public/pg_temp) — this function is not part of the pinned
-- search_path set (s5.30) and preserving its exact prior behaviour matters
-- more here than adopting this migration's stricter default.
-- ---------------------------------------------------------------------------
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
     and p.deleted_at is null
     and p.merged_into_id is null
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

revoke all on function public.resolve_patient_guarded(text, text, date, jsonb) from public;
revoke execute on function public.resolve_patient_guarded(text, text, date, jsonb) from anon, authenticated;
grant execute on function public.resolve_patient_guarded(text, text, date, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- (11) appointment_attachments: BEFORE DELETE guard (coordinator follow-up,
-- 2026-09-25). A lab-request upload row cannot be removed while its owning
-- patient is inactive — deleted or merged — same P0058 every other write
-- against an inactive patient raises. Spec:
-- docs/superpowers/specs/2026-09-24-patient-delete-design.md ("deleting an
-- attachment on an inactive patient is refused by the database").
-- SECURITY INVOKER, like (4)'s guard, so it runs as whichever role issues
-- the DELETE. deletePatientLabRequestUpload runs it via the admin
-- (service_role) client, which already holds default SELECT on both
-- appointment_attachments and patients and bypasses RLS — this migration
-- grants it nothing new. A row with no patient_id (the column allows null;
-- never actually null in practice — every insert path sets it) has nothing
-- to check against and is left alone.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_appointment_attachment_delete()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_deleted_at      timestamptz;
  v_merged_into_id  uuid;
begin
  if old.patient_id is null then
    return old;
  end if;

  select p.deleted_at, p.merged_into_id
    into v_deleted_at, v_merged_into_id
    from public.patients p
   where p.id = old.patient_id;

  if v_deleted_at is not null or v_merged_into_id is not null then
    raise exception 'the patient record for this upload is inactive — restore it (or resolve the merge) before removing the file'
      using errcode = 'P0058';
  end if;

  return old;
end;
$$;

revoke all on function public.enforce_appointment_attachment_delete() from public, anon, authenticated, service_role;

drop trigger if exists trg_appointment_attachments_delete_guard on public.appointment_attachments;
create trigger trg_appointment_attachments_delete_guard
  before delete on public.appointment_attachments
  for each row execute function public.enforce_appointment_attachment_delete();
