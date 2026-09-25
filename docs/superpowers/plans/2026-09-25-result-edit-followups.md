# Result-edit follow-ups (after #223) — plan

Branch `feat/result-edit-followups` off `a7249ec`. Migration **0176** (claimed). No new P-codes.
Prod facts checked read-only 2026-09-25: 0 `result_amendments`, 2 patient `result.downloaded`
rows (both single-test shape, `resource_id` = results.id); `anon`/`authenticated` hold table-level
grants on `results` (a new column is readable under the existing row policies); the only service
still on an inactive single-service template is `NA` (send-out placeholder, 511 released legacy
lines, no open work) — `prepareStructured` already refuses send-outs.

## 1. Patient "Result updated" marker (owner decision)
- `results.patient_last_downloaded_at timestamptz` (0176). Marker = downloaded AND
  `patient_last_downloaded_at < amended_at`. Never downloaded → no marker; downloading the new
  version hides it. No reason is shown.
- Written by `result_note_patient_download(p_served jsonb)` — service_role only, one row per
  `{result_id, storage_path}` actually served. Uses DB time, monotonic (`greatest`), and when the
  served path is no longer current (an edit committed between our read and the write) records a time
  just BEFORE `amended_at`, so a patient who got the old file still sees the marker.
- Callers: all three portal actions (single, consolidated, package — each component served) and the
  data-export ZIP (it hands out the PDFs too; its audit row now lists `result_ids`). A failed write is
  logged, never fails the download.
- Backfill in 0176 from patient `result.downloaded` rows: `resource_id` = a result (single +
  consolidated), `metadata.test_request_id`, and `merged_component_ids` / `test_request_ids`
  of `package_consolidated` rows → results through `result_test_requests`. Max per result.
- Portal: standalone rows, package card (any component updated) + component rows, visit page.
  Pure helper `src/lib/results/patient-update-marker.ts` + tests. Guide.

## 2. Clinic-only "Updated … by … — reason" remark (owner decision)
- `result_amendment_remarks(uuid[])` (0176): SECURITY DEFINER, same row shape as
  `queue_claim_remarks`, action `result.amended`, one row per member test of the amended result,
  gated per result by `staff_can_read_finished_result` (reception → nothing; medtech only for
  reports wholly in their sections). ≤200 ids.
- `fetchClaimEvents` merges both RPCs (Visit page opts out — it only needs unclaims).
  `claimRemarks` words it `Updated <Manila date/time> by <who> — “reason”`; notable; the list
  doesn't repeat the time under it. Heading "Claim history" → "History". Never PDF/portal.

## 3. seed-services
Every seeded service gets its prod `section` (URINALYSIS → urinalysis, consults → consultation,
generic CONSULT → null as on prod…). Seed-time check that every lab_test has a section.

## 4. prepareStructured template lookup gets `.eq("is_active", true)`.

## 5. Every-member section gate for the CURRENT PDF of a shared report
`reportWithinSections(admin, resultId, role)` (pure core `membersWithinSections`): lab roles only
(`sectionsForRole` non-empty array); every linked member, deleted included, NULL section = outside.
Applied in `/staff/results/[id]/pdf` (current path; reception keeps #221 rules) and
`getResultDownloadUrl`. Also check `/visits/[id]/results-pdf`.

## 6. Coverage
- Whole-report undo race: extract `undoUpdateIds` (pure) + test a member released after the
  candidate read is in the UPDATE set.
- Failed value read: extract `reportEditFormState` (pure) used by the consolidated page; server
  `amendConsolidatedReport` fails closed on template/map/stored read errors; tests.
- Lost-response replay: `commitResultEdit` with an RPC error + probe=true → replayed, alerts =
  sent; `auditAlertChanges` writes `outcome_replayed: true`.

## 7. CLAUDE.md migration ledger → prod head 0173 (+0176 after push).

## 8. (#223 review P2) print audit records the SERVED version
`amendment_count: (requestedVersion ?? currentVersion) - 1`; test that printing v1 after v2 exists
leaves v2's "Printed" note empty.

## Verify
Local DB smoke (docker psql), npm test/typecheck/lint, click-through on :3017, Codex astra high +
Fable, PR, `db push --dry-run` then push, merge, prod deploy check.
