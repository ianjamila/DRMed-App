-- =============================================================================
-- 0042 — Package completion stamp on header release
-- =============================================================================
-- Complements the trigger from 0040 (fn_set_package_completed_at, which stamps
-- when the last COMPONENT becomes terminal) with a symmetric leg that stamps
-- when the HEADER itself reaches 'released' — for the case where all
-- components became terminal BEFORE the header released.
--
-- The natural production flow has the 12.2 payment-gating trigger flip both
-- header and components to 'released' in a single visit-payment transaction.
-- The order of those AFTER UPDATE triggers is unspecified by Postgres. If the
-- header release fires last, the 0040 component-side trigger will have already
-- run for the last component and bailed because the header was not yet
-- 'released'. Without this complementary trigger, package_completed_at would
-- stay NULL permanently.
-- =============================================================================

create or replace function public.fn_check_header_completion_on_release()
returns trigger language plpgsql as $$
declare
  v_pending int;
begin
  if new.is_package_header = false then return new; end if;
  if new.status <> 'released' then return new; end if;
  if old.status = 'released' then return new; end if;
  if new.package_completed_at is not null then return new; end if;

  select count(*) into v_pending
    from public.test_requests
    where parent_id = new.id
      and status not in ('released', 'cancelled');

  if v_pending = 0 then
    new.package_completed_at := now();
  end if;
  return new;
end;
$$;

create trigger tg_check_header_completion_on_release
  before update of status on public.test_requests
  for each row execute function public.fn_check_header_completion_on_release();
