-- =============================================================================
-- 0130 — Backfill package components for headers stuck with no component rows
--         (partner revisions audit item 15)
-- =============================================================================
-- SYMPTOM: /staff/queue/[id] branches on is_package_header=true and, when no
-- test_requests row has parent_id = header.id, renders "No component test
-- requests linked to this header." — a dead end. Results can never be entered
-- because there is nothing to enter them against.
--
-- PREMISE CORRECTION: the audit (item 15) attributed this to "pre-0040 legacy
-- flat packages." That is wrong. Per 0040's design doc
-- (docs/superpowers/specs/2026-05-17-14-package-decomposition-design.md §5.9),
-- pre-0040 rows were deliberately left as is_package_header = false, parent_id
-- NULL — they look like, and are treated as, standalone test_requests by every
-- post-0040 code path (§5.9, §5.10). They use the ordinary single-test result
-- path and NEVER reach the is_package_header branch, so they cannot produce
-- this symptom.
--
-- ACTUAL ROOT CAUSE: visits/new/actions.ts createOneVisit() inserts a package
-- header row in one PostgREST call, then its component rows in a LATER,
-- separate call (header insert → decomposition lookup → component insert are
-- three round trips, not one transaction). If the process crashes, times out,
-- or a component insert fails validation between the header insert and the
-- component insert, the header is left committed with zero children. The
-- catch block's compensating deleteVisitCascade() only runs when the SAME
-- request execution observes the error — it cannot help a header orphaned by
-- a crash, a lost response, or a serverless cold-start timeout mid-request.
--
-- We could not query prod to confirm which population actually exists there
-- (classifier blocks direct querying), so this migration defensively repairs
-- BOTH populations it is theoretically possible to find, and is a no-op for
-- whichever population turns out to be absent.
--
-- POPULATION A — orphaned Phase-14 headers (the actual, likely, root cause):
--   is_package_header = true, status <> 'cancelled', not soft-deleted (0125),
--   with zero rows having parent_id = header.id. For each, one component
--   test_request is inserted per package_components row configured for the
--   header's service_id, mirroring createOneVisit's componentRows shape
--   exactly: base_price_php/discount_amount_php/final_price_php = 0, HMO
--   fields copied from the header, parent_id = header.id,
--   is_package_header = false, status left at its table default ('requested').
--   requested_at is copied from the header so the component sits at its
--   original order time in queue ordering, not "now". Order-time validation
--   (loadPackageDecompositionsForLines) guarantees package_components existed
--   when the header was created, so a header found with NO config today means
--   the config was deleted afterward — that is surfaced as a hard failure
--   (RAISE EXCEPTION), not silently skipped, because skipping would leave a
--   dead-end header with no way to ever resolve it.
--
-- POPULATION B — true pre-0040 legacy flat packages (defensive; §5.9 says this
-- population should not exist, but we cannot verify against prod):
--   is_package_header = false, parent_id IS NULL, service.kind = 'lab_package',
--   status IN ('requested','in_progress'), not soft-deleted, with NO result
--   attached. "No result attached" is checked via result_test_requests only —
--   results.test_request_id was DROPPED in 0051_consolidated_reports_and_
--   signatures.sql; result_test_requests(test_request_id, result_id) is the
--   sole linkage since. Released/completed legacy packages (status not in the
--   two above, or carrying a result) are deliberately left untouched — their
--   clinical/billing history stands as-is; only in-flight rows that cannot
--   otherwise progress are converted.
--
--   Convert: is_package_header := true, status := 'ready_for_release' — the
--   resting state a Phase-14 header normally reaches via
--   tg_header_auto_promote (0040), which is a BEFORE INSERT trigger and so
--   does NOT fire on this UPDATE. Setting status directly is safe here because
--   every gate that matters keys off a specific status transition, not this
--   one:
--     - enforce_payment_before_release (0001) and enforce_consent_before_
--       release (0086) both key on new.status = 'released' — untouched.
--     - tg_header_auto_promote (0040) is INSERT-only.
--     - tg_set_package_completed_at / tg_release_header_when_components_done
--       (0040/0109) both early-return on new.parent_id IS NULL — this row has
--       no parent, so both no-op.
--   The row's own price fields (base/discount/final_price_php) are left
--   untouched — a converted header carries the real historical package price,
--   same as a Phase-14 header always has.
--   If a Population-B row's service has NO package_components config, this is
--   plausible (a retired legacy package may never have gotten Phase-14
--   composition data) and is NOT an error: RAISE NOTICE and leave the row
--   alone, still on its still-functional legacy single-test result path.
--
-- COMPONENTS ARE GL-SILENT BY DESIGN, BOTH POPULATIONS: bridge_test_request_
-- released / bridge_test_request_cancelled both early-return when
-- new.parent_id IS NOT NULL (0041, restored by 0109 after a real prod
-- incident where 0064's rewrite dropped the guard and broke every package
-- release). The backfilled component rows inserted here carry parent_id, so
-- they will NEVER independently post a journal entry — they roll up to their
-- header, exactly like Phase-14-native components. Do not remove that guard.
--
-- WHY A PLAIN INSERT/UPDATE IS SAFE HERE (no gate bypass): a bare INSERT of
-- status='requested' fires no gating trigger at all (payment gate, consent
-- gate, GL bridges, tg_set_package_completed_at, and the 0109 Leg A/B header
-- auto-release all key off UPDATE, several specifically off a transition to
-- 'released'). The Population-B UPDATE to 'ready_for_release' is likewise
-- inert against every one of those gates, as detailed above.
--
-- IDEMPOTENCY: Population A's predicate is "zero children exist" — as soon as
-- children are inserted, the header no longer matches and a re-run skips it.
-- Population B's predicate includes "is_package_header = false" — as soon as
-- a row is converted, it no longer matches and a re-run skips it. Re-running
-- this file after a partial or full prior run is a no-op over already-fixed
-- rows. On a freshly-reset, empty database (`supabase db reset` replays every
-- migration against empty tables) both loops iterate zero times and the
-- postcondition guard passes trivially.
--
-- SKIP-WITH-NOTICE RULE: Population A missing config => RAISE EXCEPTION (order
-- time guarantees config existed; disappearance is a real data problem to
-- surface). Population B missing config => RAISE NOTICE and skip (legacy rows
-- predate the composition system and may legitimately have none) — this must
-- NEVER fail the whole migration.
--
-- DIAGNOSTIC QUERY — run this against prod BEFORE applying, to preview what
-- this migration will touch:
--
--   -- Population A candidates (orphaned headers):
--   select tr.id, tr.visit_id, tr.status, s.code, s.name,
--          exists (select 1 from public.package_components pc
--                   where pc.package_service_id = tr.service_id) as has_config
--     from public.test_requests tr
--     join public.services s on s.id = tr.service_id
--    where tr.is_package_header = true
--      and tr.status <> 'cancelled'
--      and tr.deleted_at is null
--      and not exists (select 1 from public.test_requests c where c.parent_id = tr.id);
--
--   -- Population B candidates (legacy flat packages, in-flight, no result):
--   select tr.id, tr.visit_id, tr.status, s.code, s.name,
--          exists (select 1 from public.package_components pc
--                   where pc.package_service_id = tr.service_id) as has_config
--     from public.test_requests tr
--     join public.services s on s.id = tr.service_id
--    where tr.is_package_header = false
--      and tr.parent_id is null
--      and s.kind = 'lab_package'
--      and tr.status in ('requested', 'in_progress')
--      and tr.deleted_at is null
--      and not exists (select 1 from public.result_test_requests rtr
--                       where rtr.test_request_id = tr.id);
--
-- NOT COVERED: released/completed legacy packages (kept exactly as-is, per
-- §5.9's own design intent); cancelled headers/rows (no result entry is ever
-- expected of a cancelled test); soft-deleted rows (0125) (already excluded
-- from operational queues, restoring is a separate, already-guarded flow).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Population A — orphaned Phase-14 headers with zero component rows.
-- ---------------------------------------------------------------------------
do $$
declare
  v_header   record;
  v_svc_code text;
begin
  for v_header in
    select tr.id, tr.visit_id, tr.service_id, tr.requested_by, tr.requested_at,
           tr.hmo_provider_id, tr.hmo_approval_date, tr.hmo_authorization_no
      from public.test_requests tr
      join public.visits v on v.id = tr.visit_id
     where tr.is_package_header = true
       and tr.status <> 'cancelled'
       and tr.deleted_at is null
       and v.deleted_at is null
       and not exists (
         select 1 from public.test_requests c where c.parent_id = tr.id
       )
  loop
    if not exists (
      select 1 from public.package_components pc
       where pc.package_service_id = v_header.service_id
    ) then
      select s.code into v_svc_code from public.services s where s.id = v_header.service_id;
      raise exception
        '0130 Population A: orphaned package header % (visit %, service % / %) has NO package_components config. Order-time validation guarantees config existed when this header was created — its disappearance since means the composition was deleted and must be restored (or the config re-created) before this backfill can proceed. Not skipping: this header would otherwise remain a permanent dead end.',
        v_header.id, v_header.visit_id, v_header.service_id, coalesce(v_svc_code, '(service not found)');
    end if;

    insert into public.test_requests (
      visit_id, service_id, requested_by, requested_at,
      base_price_php, discount_amount_php, final_price_php,
      hmo_provider_id, hmo_approval_date, hmo_authorization_no,
      parent_id, is_package_header
    )
    select
      v_header.visit_id, pc.component_service_id, v_header.requested_by, v_header.requested_at,
      0, 0, 0,
      v_header.hmo_provider_id, v_header.hmo_approval_date, v_header.hmo_authorization_no,
      v_header.id, false
      from public.package_components pc
     where pc.package_service_id = v_header.service_id
     order by pc.sort_order;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Population B — true legacy flat packages, in-flight, no result attached.
-- Defensive: §5.9 says this population should not exist, but we could not
-- verify prod. Missing config here is NOT fatal (RAISE NOTICE + skip).
-- ---------------------------------------------------------------------------
do $$
declare
  v_row      record;
  v_svc_code text;
begin
  for v_row in
    select tr.id, tr.visit_id, tr.service_id, tr.requested_by, tr.requested_at,
           tr.hmo_provider_id, tr.hmo_approval_date, tr.hmo_authorization_no
      from public.test_requests tr
      join public.services s on s.id = tr.service_id
      join public.visits v on v.id = tr.visit_id
     where tr.is_package_header = false
       and tr.parent_id is null
       and s.kind = 'lab_package'
       and tr.status in ('requested', 'in_progress')
       and tr.deleted_at is null
       and v.deleted_at is null
       and not exists (
         select 1 from public.result_test_requests rtr
          where rtr.test_request_id = tr.id
       )
  loop
    if not exists (
      select 1 from public.package_components pc
       where pc.package_service_id = v_row.service_id
    ) then
      select s.code into v_svc_code from public.services s where s.id = v_row.service_id;
      raise notice
        '0130 Population B: legacy flat package test_request % (visit %, service % / %) has no package_components config — leaving it as a flat row on the legacy single-test result path. This is expected for retired legacy packages that predate Phase-14 composition data.',
        v_row.id, v_row.visit_id, v_row.service_id, coalesce(v_svc_code, '(service not found)');
      continue;
    end if;

    update public.test_requests
       set is_package_header = true,
           status = 'ready_for_release'
     where id = v_row.id;

    insert into public.test_requests (
      visit_id, service_id, requested_by, requested_at,
      base_price_php, discount_amount_php, final_price_php,
      hmo_provider_id, hmo_approval_date, hmo_authorization_no,
      parent_id, is_package_header
    )
    select
      v_row.visit_id, pc.component_service_id, v_row.requested_by, v_row.requested_at,
      0, 0, 0,
      v_row.hmo_provider_id, v_row.hmo_approval_date, v_row.hmo_authorization_no,
      v_row.id, false
      from public.package_components pc
     where pc.package_service_id = v_row.service_id
     order by pc.sort_order;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Postcondition guard: zero non-cancelled, non-deleted headers with zero
-- children remain among services that HAVE package_components config. (A
-- header whose config is genuinely absent already aborted the migration in
-- the Population A loop above, so it cannot reach here — this guard is a
-- second line of defense against a future regression re-introducing orphans,
-- e.g. a bug reintroducing a header without its components in the same
-- migration run.) Trivially passes on an empty/fresh database.
-- ---------------------------------------------------------------------------
do $$
declare
  v_offenders text;
begin
  select string_agg(tr.id::text, ', ')
    into v_offenders
    from public.test_requests tr
   where tr.is_package_header = true
     and tr.status <> 'cancelled'
     and tr.deleted_at is null
     and exists (
       select 1 from public.package_components pc
        where pc.package_service_id = tr.service_id
     )
     and not exists (
       select 1 from public.test_requests c where c.parent_id = tr.id
     );

  if v_offenders is not null then
    raise exception
      '0130 postcondition failed: header(s) still have zero component rows despite having package_components config: %',
      v_offenders;
  end if;
end $$;
