-- =============================================================================
-- 0137_xray_technician_result_policies.sql
-- =============================================================================
-- N7 (go-live, once an x-ray technician exists): xray_technician cannot read
-- back the results it entered itself.
--
-- 0023_xray_technician_role.sql added the `xray_technician` role and
-- extended every RLS policy that governed the lab-result surfaces at the
-- time, including `result_values` (the table existed pre-0051; it was keyed
-- straight off `results.test_request_id`).
--
-- 0051_consolidated_reports_and_signatures.sql then reworked the results
-- schema into a many-to-many shape: it created the `result_test_requests`
-- junction table, dropped `results.test_request_id`, and — because those
-- three `result_values` policies read `test_request_id` through that
-- dropped column — DROPPED and RECREATED them to walk the new junction
-- instead (see 0051 "-- 6. Drop policies that depend on
-- results.test_request_id" / "-- 10. Recreate dropped policies to walk
-- junction"). The recreated role arrays regressed to the pre-0023 list
-- (`medtech`/`pathologist`/`admin`) — `xray_technician` was silently
-- dropped in the rewrite. The brand-new `result_test_requests` table's own
-- policies (created fresh in that same migration) were never given
-- `xray_technician` either.
--
-- No migration between 0051 and 0136 touches either table's staff policies
-- (verified: `grep -rn "xray_technician" supabase/migrations/*.sql` and
-- `grep -rn "result_test_requests\|result_values" supabase/migrations/*.sql`
-- surface no later create-policy statement on these two tables) — the gap
-- is live on prod today.
--
-- Concretely broken by the gap, both via the RLS-scoped server client
-- (src/lib/supabase/server.ts), never the admin client:
--   * src/app/(staff)/staff/(dashboard)/queue/[id]/page.tsx embeds
--     `results` under `test_requests` — PostgREST resolves that embed
--     through the `result_test_requests` junction, so its RLS applies to
--     the traversal even though `results`' own staff-select policy (0023,
--     untouched since, already lists xray_technician) is fine on its own.
--     Without a `result_test_requests` grant the embed silently returns no
--     row for an xray_technician, hiding a result that exists.
--   * The same page's structured-form pre-fill reads `result_values`
--     through that same RLS-scoped client — "result_values: read by owning
--     medtech + pathologist + admin" only bypasses for pathologist/admin or
--     matches `medtech` + own claim, so an xray_technician who claimed and
--     entered an imaging_report structured result sees a BLANK form on
--     reload, with no error — their own values are unreadable back.
--
-- NOT affected, confirmed by grep — no fix needed here:
--   * `results: staff select` / `results: medtech/pathologist/admin write`
--     (0023) — created once, never recreated since; still list
--     xray_technician.
--   * `result_amendments: staff read` / `... write` (0026, after 0023) —
--     already lists xray_technician, never recreated since.
--
-- Fix: re-create the four regressed policies with xray_technician restored,
-- byte-identical to 0051's bodies otherwise. Hand-written (policy diffs are
-- noisy) — no function touched, so no ACL to restate (0118/0119 rule N/A).
-- =============================================================================

-- ----- result_test_requests: staff read --------------------------------------
drop policy if exists "result_test_requests: staff read" on public.result_test_requests;
create policy "result_test_requests: staff read"
  on public.result_test_requests for select to authenticated
  using (public.has_role(array['reception', 'medtech', 'pathologist', 'admin', 'xray_technician']));

-- ----- result_values: medtech write own claimed test -------------------------
drop policy if exists "result_values: medtech write own claimed test" on public.result_values;
create policy "result_values: medtech write own claimed test"
  on public.result_values for insert to authenticated
  with check (
    public.has_role(array['medtech', 'pathologist', 'admin', 'xray_technician'])
    and exists (
      select 1
      from public.result_test_requests rtr
      join public.test_requests tr on tr.id = rtr.test_request_id
      where rtr.result_id = result_values.result_id
        and (
          public.has_role(array['pathologist', 'admin'])
          or (
            tr.assigned_to = auth.uid()
            and tr.status in ('in_progress', 'result_uploaded')
          )
        )
    )
  );

-- ----- result_values: medtech update own claimed test -------------------------
drop policy if exists "result_values: medtech update own claimed test" on public.result_values;
create policy "result_values: medtech update own claimed test"
  on public.result_values for update to authenticated
  using (
    public.has_role(array['medtech', 'pathologist', 'admin', 'xray_technician'])
    and exists (
      select 1
      from public.result_test_requests rtr
      join public.test_requests tr on tr.id = rtr.test_request_id
      where rtr.result_id = result_values.result_id
        and (
          public.has_role(array['pathologist', 'admin'])
          or (
            tr.assigned_to = auth.uid()
            and tr.status in ('in_progress', 'result_uploaded')
          )
        )
    )
  )
  with check (
    public.has_role(array['medtech', 'pathologist', 'admin', 'xray_technician'])
    and exists (
      select 1
      from public.result_test_requests rtr
      join public.test_requests tr on tr.id = rtr.test_request_id
      where rtr.result_id = result_values.result_id
        and (
          public.has_role(array['pathologist', 'admin'])
          or (
            tr.assigned_to = auth.uid()
            and tr.status in ('in_progress', 'result_uploaded')
          )
        )
    )
  );

-- ----- result_values: read by owning medtech + pathologist + admin -----------
-- Name kept identical to 0051 (renaming would drop-then-recreate under a
-- different name for no behavioural reason); the body now also covers the
-- owning xray_technician.
drop policy if exists "result_values: read by owning medtech + pathologist + admin" on public.result_values;
create policy "result_values: read by owning medtech + pathologist + admin"
  on public.result_values for select to authenticated
  using (
    public.has_role(array['pathologist', 'admin'])
    or exists (
      select 1
      from public.result_test_requests rtr
      join public.test_requests tr on tr.id = rtr.test_request_id
      where rtr.result_id = result_values.result_id
        and tr.assigned_to = auth.uid()
        and public.has_role(array['medtech', 'xray_technician'])
    )
  );
