-- =============================================================================
-- 0116_na_send_out_config.sql
-- =============================================================================
-- Data change. NA (Sodium) is performed by an outside lab, not on the bench,
-- but was still catalogued as an in-house chemistry test. This reclassifies it
-- as a send-out routed to Hi Precision.
--
-- Four coordinated edits to the single `services` row for code 'NA':
--   1. is_send_out        false → true
--   2. send_out_lab       null  → 'Hi Precision'   (matches all 82 others)
--   3. send_out_vendor_id null  → the Hi Precision vendors row
--   4. section            'chemistry' → 'send_out'
-- plus deactivating NA's now-unreachable per-service result template.
--
-- DELIBERATELY NOT SET: send_out_unit_cost_php. What Hi Precision bills the
-- clinic per sodium test is not known yet, and this column feeds COGS and the
-- general ledger — a guessed figure would post real, wrong accounting. NA is
-- therefore left in exactly the state all 82 existing send-outs are already in
-- (both vendor cost columns NULL), which is the system's normal, tracked
-- condition rather than a new anomaly.
--
-- How the gap gets closed: `is_send_out = true` with a NULL cost makes NA list
-- itself on /staff/admin/accounting/cogs/send-outs/unconfigured, whose query is
-- `is_send_out AND (send_out_unit_cost_php is null or = 0)`. Once the clinic has
-- the real per-test cost, an admin enters it there via updateSendOutConfig,
-- which writes a service.send_out_config_updated audit row. No migration needed.
--
-- COGS behaviour until then (0064, unchanged from every other send-out): each
-- NA release takes the zero-cost branch — a cogs_send_out_entries row with
-- unit_cost_php = 0 and journal_entry_id = null, no DR 6420 / CR 2150 lines.
-- Because vendor_id IS set, those entries stay attributable to Hi Precision, so
-- a later cogs_send_out_trueups match can restate them against a real bill.
-- Revenue is untouched: NA still books ₱205 DR 1100 / CR 4100 on release, and
-- the 511 already-released NA tests are not affected retroactively.
--
-- Section move: all 82 current send-outs sit in section 'send_out'; leaving NA
-- in 'chemistry' would make it the lone exception. No queue-access change —
-- sectionsForRole grants medtech both 'chemistry' and 'send_out'. It does move
-- NA into the send-out group on the public services listing.
--
-- Template deactivation: 0 of the 82 send-outs carry an active per-service
-- template, and queue/[id]/page.tsx skips the structured form entirely when
-- is_send_out is true, so NA's template becomes unreachable the moment (1)
-- lands. Deactivating (not deleting) keeps its 1 param row and the 1 historical
-- result_values row referencing it intact, and is reversible.
--
-- Idempotent: every statement is a targeted UPDATE whose WHERE clause stops
-- matching once applied.
--
-- REPLAY SAFETY (corrected 2026-07-27): an earlier version of this comment
-- claimed the NA row is "seeded by earlier migrations". It is not — the service
-- catalogue and the vendors list are both seeded by scripts (seed-services.ts /
-- import-test-list.ts), never by a migration. On a database built from
-- migrations alone, `services` is EMPTY, the two UPDATEs match nothing, and the
-- post-condition below used to abort the whole replay with 'service NA not
-- found'. That made `supabase db reset` impossible to complete, so fresh local
-- environments and CI could not be built from migrations at all.
--
-- The post-condition now skips when there is no NA row to reclassify, and still
-- fails loudly when the row IS present and the reclassification did not take.
-- =============================================================================

update public.services s
   set is_send_out        = true,
       send_out_lab       = 'Hi Precision',
       send_out_vendor_id = v.id,
       section            = 'send_out'
  from public.vendors v
 where s.code = 'NA'
   and v.name = 'Hi Precision'
   and (s.is_send_out is distinct from true
     or s.send_out_lab is distinct from 'Hi Precision'
     or s.send_out_vendor_id is distinct from v.id
     or s.section is distinct from 'send_out');

-- The structured-entry form is unreachable for send-outs; results now arrive as
-- an uploaded report from the outside lab.
update public.result_templates rt
   set is_active = false
  from public.services s
 where s.id = rt.service_id
   and s.code = 'NA'
   and rt.is_active;

-- Guard: fail loudly rather than leave a half-applied reclassification behind.
-- The unit cost is intentionally excluded — its absence is the tracked,
-- expected state described above, not an error.
do $$
declare
  r record;
begin
  -- Nothing to reclassify on a catalogue-less database (a fresh replay). Skip
  -- rather than abort — see REPLAY SAFETY in the header.
  if not exists (select 1 from public.services where code = 'NA') then
    raise notice
      '0116: no services row with code NA — nothing to reclassify. This is expected on a database built from migrations alone; the catalogue is seeded separately by scripts/seed-services.ts.';
    return;
  end if;

  select s.is_send_out, s.send_out_lab, s.send_out_vendor_id,
         s.send_out_unit_cost_php, s.section, v.name as vendor_name
    into r
    from public.services s
    left join public.vendors v on v.id = s.send_out_vendor_id
   where s.code = 'NA';

  if not r.is_send_out
     or r.send_out_vendor_id is null
     or r.vendor_name is distinct from 'Hi Precision'
     or r.send_out_lab is distinct from 'Hi Precision'
     or r.section is distinct from 'send_out' then
    raise exception
      'NA send-out reclassification incomplete: send_out=% vendor=% lab=% section=%',
      r.is_send_out, r.vendor_name, r.send_out_lab, r.section;
  end if;

  if r.send_out_unit_cost_php is null then
    raise notice
      'NA send-out unit cost is not set — NA will appear on the unconfigured send-outs page until the clinic supplies Hi Precision''s per-test cost.';
  end if;
end $$;
