-- =============================================================================
-- 0138 — HMO package header release (A3, go-live)
-- =============================================================================
-- Finding A3: HMO package headers never release, so package revenue is never
-- booked.
--
-- 0109 (package_release_lifecycle) added two triggers that auto-release a
-- package header once its components are settled:
--   * fn_release_header_when_components_done / tg_release_header_when_
--     components_done — fires on test_requests status UPDATE, right after the
--     last component goes terminal.
--   * fn_release_headers_on_visit_paid / tg_release_headers_on_visit_paid —
--     fires on visits.payment_status UPDATE, in case the header was still
--     waiting when payment lands after the components already finished.
--
-- 0133 extended the *release gate itself* (enforce_payment_before_release) so
-- an HMO-billed visit (hmo_provider_id is not null) may release before
-- payment_status ever reaches paid/waived — an HMO patient never pays at the
-- counter; releasing is precisely what books the AR-HMO receivable (0109/
-- 0131). But 0133 deliberately left these two header triggers untouched (see
-- its own header comment), reasoning a header could still be released "by
-- hand" now that the gate allows it. That manual control does not exist in
-- the app yet, so on an HMO + package visit today:
--   * every COMPONENT releases fine — 0133's carve-out covers them,
--   * the HEADER's own guard still tests payment_status in ('paid','waived')
--     with no HMO carve-out, so it never flips to 'released',
--   * bridge_test_request_released (0109) only posts the package price from
--     the HEADER row — component rows are ₱0 and are explicitly skipped by
--     the function's own guard — so the package revenue line and the AR-HMO
--     receivable are NEVER booked, and the portal's package PDF stays locked
--     indefinitely.
--
-- Prod has 0 stuck headers today only because no HMO + package visit has run
-- through the app yet (verified 2026-09-11) — there are 2,420 HMO visits in
-- history and 16 active packages, so this fires on the very first one.
--
-- This migration extends BOTH triggers with the identical HMO carve-out 0133
-- gave the release gate, mirroring its predicate wording exactly so the two
-- cannot drift:
--
--   payment_status in ('paid', 'waived') OR hmo_provider_id is not null
--
--   1. fn_release_header_when_components_done — its settled-money check now
--      also reads visits.hmo_provider_id, not just payment_status.
--   2. fn_release_headers_on_visit_paid — the function BODY needs no change
--      (its per-header EXISTS/NOT EXISTS logic never referenced
--      payment_status), but the TRIGGER's WHEN clause only fired on a
--      payment_status transition to paid/waived — which an HMO visit may
--      never make. Widened to also fire when hmo_provider_id is newly set
--      (e.g. reception attaches an HMO to a visit whose components already
--      finished under the old cash-only gate), so a header that was blocked
--      for that reason gets a second chance to release the moment the HMO is
--      recorded, without waiting on the next component's status change.
--
-- src/lib/visits/money-settled.ts documents this predicate for the app side,
-- and its unit test (money-settled.test.ts) pins 0133's SQL TEXT specifically
-- — the release GATE (enforce_payment_before_release), not these header
-- triggers. That text is untouched by this migration, so the test needs no
-- change. See the PR/report for the sweep of every other
-- "payment_status in ('paid'" call site checked for the same gap.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. fn_release_header_when_components_done — add the HMO carve-out.
--    Body is 0109's, with only the visit lookup and the settled-money guard
--    changed.
-- ---------------------------------------------------------------------------
create or replace function public.fn_release_header_when_components_done()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pending  int;
  v_released int;
  v_paystat  text;
  v_hmo_id   uuid;
begin
  if new.parent_id is null then return new; end if;
  if new.status not in ('released', 'cancelled') then return new; end if;
  if old.status = new.status then return new; end if;

  select count(*) filter (where status not in ('released','cancelled')),
         count(*) filter (where status = 'released')
    into v_pending, v_released
    from public.test_requests
    where parent_id = new.parent_id;

  -- A fully-cancelled package (0 released) must NOT release — the cascade-
  -- cancel trigger (0040) owns that path.
  if v_pending > 0 or v_released = 0 then return new; end if;

  select payment_status, hmo_provider_id into v_paystat, v_hmo_id
    from public.visits where id = new.visit_id;

  -- Settled-money predicate — mirrors 0133's enforce_payment_before_release
  -- word for word; keep the two in lockstep.
  if v_paystat not in ('paid', 'waived') and v_hmo_id is null then return new; end if;

  update public.test_requests
     set status         = 'released',
         released_at    = now(),
         released_by    = auth.uid(),   -- nullable; null under service-role (0064 precedent)
         release_medium = 'other'
   where id = new.parent_id
     and status = 'ready_for_release';  -- idempotent across sibling triggers

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. fn_release_headers_on_visit_paid — body is unchanged from 0109 (it never
--    referenced payment_status directly); re-created only so the ACL
--    restatement below is self-describing per the skill's per-function
--    checklist, and so this migration is a complete standalone record of the
--    function's current text.
-- ---------------------------------------------------------------------------
create or replace function public.fn_release_headers_on_visit_paid()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  h record;
begin
  for h in
    select th.id
      from public.test_requests th
     where th.visit_id = new.id
       and th.is_package_header
       and th.status = 'ready_for_release'
       and exists (select 1 from public.test_requests c
                    where c.parent_id = th.id and c.status = 'released')
       and not exists (select 1 from public.test_requests c
                        where c.parent_id = th.id
                          and c.status not in ('released','cancelled'))
  loop
    begin
      update public.test_requests
         set status = 'released', released_at = now(),
             released_by = auth.uid(), release_medium = 'other'
       where id = h.id and status = 'ready_for_release';
    exception when others then
      -- Consent-gate rejection (check_violation) is the expected case here
      -- (withdrawn since the components released), but ANY failure — e.g.
      -- P0002 closed accounting period (0028) or P0003 zero-line JE (0029)
      -- raised by the release bridge — must never abort the payment/HMO
      -- update that triggered us. The header stays ready_for_release and
      -- releases on the next component re-release (Leg A) or manual action.
      -- Leave an audit breadcrumb (coa.suspense_post pattern) so a blocked
      -- header is distinguishable from one merely waiting on components.
      insert into public.audit_log (
        actor_id, actor_type, action, resource_type, resource_id, metadata
      ) values (
        auth.uid(),
        'system',
        'test_request.header_auto_release_failed',
        'test_request',
        h.id,
        jsonb_build_object('visit_id', new.id, 'sqlstate', SQLSTATE, 'error', SQLERRM)
      );
    end;
  end loop;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. tg_release_headers_on_visit_paid — widen the WHEN clause with the same
--    HMO carve-out. A WHEN clause can't be ALTERed, so drop + recreate.
-- ---------------------------------------------------------------------------
drop trigger if exists tg_release_headers_on_visit_paid on public.visits;

create trigger tg_release_headers_on_visit_paid
  after update of payment_status, hmo_provider_id on public.visits
  for each row
  when (
    (new.payment_status in ('paid', 'waived')
     and old.payment_status is distinct from new.payment_status)
    or (new.hmo_provider_id is not null
        and old.hmo_provider_id is distinct from new.hmo_provider_id)
  )
  execute function public.fn_release_headers_on_visit_paid();

-- ---------------------------------------------------------------------------
-- 4. Function ACLs (0118/0119 rule) — restate explicitly rather than assume
--    create-or-replace preserves them.
--
-- Both functions are bucket-C TRIGGER functions per 0118: revoked from
-- public/anon/authenticated there, with NO service_role grant restored,
-- because a trigger function's EXECUTE privilege is checked at CREATE
-- TRIGGER time (0118's FACT 1), not at fire time — so the revoke below
-- cannot stop either trigger from firing, and service_role never needed a
-- direct grant to fire them via an ordinary UPDATE.
--
-- `create or replace function` PRESERVES a function's existing ACL (unlike
-- `create or replace view`, which silently drops `security_invoker` — that
-- trap is view-specific and does not apply here), so the revokes below
-- change nothing by accident; they state the end state explicitly, matching
-- 0133's own restatement of enforce_payment_before_release's ACL.
-- ---------------------------------------------------------------------------
revoke execute on function public.fn_release_header_when_components_done() from public, anon, authenticated;
revoke execute on function public.fn_release_headers_on_visit_paid() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Backfill — release any header already stuck at ready_for_release on an
--    HMO (or paid/waived) visit whose components are all terminal, mirroring
--    fn_release_header_when_components_done's own predicate.
--
-- Guarded so it can never raise on an empty/missing-row database (the full
-- migration history must replay on a fresh local stack): each header release
-- attempt is wrapped in its own exception handler, exactly like leg B's
-- handler above, so a header the release bridge itself rejects (closed
-- period, zero-line JE, …) is logged and left for manual follow-up rather
-- than aborting the whole migration.
--
-- Prod has 0 stuck headers today (verified 2026-09-11 — no HMO + package
-- visit has gone through the app yet), so this is expected to be a no-op
-- against real data too; it exists for correctness/repeatability, not
-- because a known backlog needs clearing.
-- ---------------------------------------------------------------------------
do $$
declare
  h record;
begin
  for h in
    select th.id, th.visit_id
      from public.test_requests th
      join public.visits v on v.id = th.visit_id
     where th.is_package_header
       and th.status = 'ready_for_release'
       and th.deleted_at is null
       and v.deleted_at is null
       and (v.payment_status in ('paid', 'waived') or v.hmo_provider_id is not null)
       and exists (select 1 from public.test_requests c
                    where c.parent_id = th.id and c.status = 'released')
       and not exists (select 1 from public.test_requests c
                        where c.parent_id = th.id
                          and c.status not in ('released','cancelled'))
  loop
    begin
      update public.test_requests
         set status = 'released', released_at = now(),
             released_by = auth.uid(), release_medium = 'other'
       where id = h.id and status = 'ready_for_release';
    exception when others then
      insert into public.audit_log (
        actor_id, actor_type, action, resource_type, resource_id, metadata
      ) values (
        null,
        'system',
        'test_request.header_auto_release_failed',
        'test_request',
        h.id,
        jsonb_build_object(
          'visit_id', h.visit_id,
          'sqlstate', SQLSTATE,
          'error',    SQLERRM,
          'source',   '0138_backfill'
        )
      );
    end;
  end loop;
end $$;
