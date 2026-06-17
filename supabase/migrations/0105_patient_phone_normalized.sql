-- 0105_patient_phone_normalized.sql
-- Maintained last-10-digits phone for index-friendly dedup blocking.

alter table public.patients add column if not exists phone_normalized text;

create or replace function public.normalise_patient_phone()
returns trigger language plpgsql as $$
begin
  if new.phone is null then
    new.phone_normalized := null;
  else
    new.phone_normalized := right(regexp_replace(new.phone, '\D', '', 'g'), 10);
    if new.phone_normalized = '' or length(new.phone_normalized) <> 10 then
      new.phone_normalized := null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_patients_normalise_phone on public.patients;
create trigger trg_patients_normalise_phone
  before insert or update of phone on public.patients
  for each row execute function public.normalise_patient_phone();

-- One-time backfill (sets column directly; does not re-fire the phone trigger).
update public.patients
set phone_normalized = right(regexp_replace(phone, '\D', '', 'g'), 10)
where phone is not null;
update public.patients
set phone_normalized = null
where phone_normalized is not null and length(phone_normalized) <> 10;

create index if not exists idx_patients_phone_normalized
  on public.patients (phone_normalized) where phone_normalized is not null;
