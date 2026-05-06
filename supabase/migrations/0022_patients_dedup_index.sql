-- =============================================================================
-- 0022_patients_dedup_index.sql
-- =============================================================================
-- Supports the silent dedup path on /schedule: when a public booking comes
-- in we look up an existing patient by (email, last_name, birthdate) before
-- inserting a new row. As the patients table grows this lookup needs an
-- index to stay fast — it's on the hot path of every public booking
-- submission.
--
-- To make the lookup index-friendly we normalise email casing at the DB
-- layer (trigger below). Lookup queries can then use equality on a plain
-- btree index instead of ILIKE + a trigram index, which is simpler and
-- faster for our access pattern.
--
-- The composite index isn't unique — legitimate duplicates remain
-- possible (e.g. typo correction in a subsequent visit). The application
-- reuses the first match and reception can merge any leftovers manually.
-- =============================================================================

-- Normalise existing rows so the trigger and new lookups see consistent
-- data. Idempotent — running again on already-lowercased data is a no-op.
update public.patients
   set email = lower(email)
 where email is not null
   and email <> lower(email);

-- BEFORE INSERT/UPDATE trigger keeps email lowercase from now on. Empty
-- string emails (which we never write, but defensive) become NULL so the
-- partial index doesn't get confused.
create or replace function public.normalise_patient_email()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.email is not null then
    new.email := lower(trim(new.email));
    if new.email = '' then
      new.email := null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_patients_normalise_email on public.patients;
create trigger trg_patients_normalise_email
  before insert or update of email on public.patients
  for each row execute function public.normalise_patient_email();

-- Composite index covers the dedup lookup. Partial on email-not-null
-- because rows without an email never participate in this match path.
create index if not exists idx_patients_dedup_lookup
  on public.patients (email, last_name, birthdate)
  where email is not null;
