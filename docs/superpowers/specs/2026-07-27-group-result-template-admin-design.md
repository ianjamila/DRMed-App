# Admin screen for consolidated report-group result templates

**Date:** 2026-07-27
**Branch:** `feat/group-result-template-admin`
**Status:** Approved design, pending implementation plan

## Problem

`report_groups` templates — the ones with `service_id is null` and
`report_group_id` set — have **no administrative surface anywhere in the app**.
Nothing can view them, edit them, preview them, or notice when they break.

Concretely, as verified against production on 2026-07-27:

- `/staff/admin/result-templates` builds its template map from rows where
  `service_id` is non-null (`page.tsx:40`). The CHEMISTRY group template is
  therefore in **no section of the index** — it is not listed as configured, not
  listed as missing, not listed at all.
- `/staff/admin/result-templates/[service_id]/edit` is keyed on `service_id`,
  which is null for a group template. There is no URL that addresses one.
- `/staff/admin/result-templates/preview/[service_id]/route.ts:54` **explicitly
  throws** when `report_group_id != null`.
- All 12 services mapped to CHEMISTRY still carry their own *deactivated*
  per-service template. Because the index only maps *active* templates, those 12
  services are filed under **"Eligible without template" with a "+ Create"
  button**. `queue/[id]/page.tsx` redirects unconditionally to the consolidated
  flow for any service carrying a `report_group_id`, so a template created that
  way is unreachable dead weight. The index actively invites the mistake.

This blind spot is why the CHEMISTRY template sat with 1 of its 14 parameters
for roughly two months (repaired by migration `0115`, shipped in #113). Nothing
in the application could have shown anyone that 13 rows were gone.

### Current production state

| Fact | Value |
|---|---|
| Report groups | 1 — `CHEMISTRY` (`Chemistry`), active |
| Services mapped to it | 12, all active, none send-out |
| Group templates | 1 — `dual_unit`, active, **14 params** (healthy post-`0115`) |
| Per-service templates on those 12 services | 12, all inactive, all unreachable |
| Migration `0117` (PR #114) | **Applied to production** — 11 services carry a send-out unit cost |

## Second fragility found during design: the encoding form's hardcoded mapping

`queue/consolidated/[visitId]/[groupId]/consolidated-form.tsx:22` holds a
hardcoded `SERVICE_TO_PARAMS` map from service **code** to parameter **name**.
It decides `enabledParamNames` — which fields the medtech is allowed to type
into. Every other field renders disabled.

**The match is by literal parameter name.** The moment this design ships an
editor that lets an admin rename a parameter, renaming `Uric Acid` to anything
else silently disables that field for `BUA_URIC_ACID`. Building the editor
without addressing this would *introduce* a new instance of the exact failure
class the editor exists to prevent. Adding a parameter or mapping a new service
likewise requires a developer and a deploy.

Two subtleties any replacement must preserve, verified against production:

- **Gendered rows.** `Creatinine` and `Uric Acid` each exist twice (one
  `gender='F'`, one `gender='M'`). A single map entry named `Creatinine` today
  matches both rows.
- **Package headers map to nothing, by design.** `LIPID_PROFILE_PACKAGE` is a
  `lab_package`: at order time it fans out (migration `0040`) into a billing
  header test_request plus ₱0 component test_requests for `CHOLESTEROL`,
  `HDL_LDL_VLDL`, `TRIGLYCERIDES` — all three present in the map. The header is
  created with `status: 'in_progress'`, so it *does* appear in the consolidated
  form's query, and its absence from the map correctly contributes zero
  enabled params — the components carry the encoding. This is not a bug; the
  backfill must keep the header mapped to zero params, and the admin screen
  must label `lab_package` members as billing headers rather than flag them as
  unmapped.

## Goals

1. Give report-group templates a full admin surface: list, edit, preview.
2. Make the index tell the truth about grouped services instead of inviting a
   no-op.
3. Make a future silent parameter loss impossible to achieve unnoticed, and hard
   to achieve at all.
4. Convert the service→parameter coupling from matched text in a client bundle
   into real, editable, identity-based data.

## Non-goals

- Full report-group CRUD (creating/renaming groups, reassigning which services
  belong to a group). CHEMISTRY exists only because migration `0053` hand-wrote
  it; the clinic has run on one group for two months and demand for self-service
  group creation is unproven. Explicitly deferred.
- Any change to how consolidated results are finalised, signed, or released.

## Design

### 1. Routes

Two new routes as siblings of the existing ones. Next.js resolves a static
segment ahead of a dynamic one, so `group` does not collide with `[service_id]`
and **no existing URL changes**.

| Route | Purpose |
|---|---|
| `/staff/admin/result-templates/group/[group_id]/edit` | Edit a group template |
| `/staff/admin/result-templates/preview/group/[group_id]` | Render a sample PDF |

The preview route replaces the `throw` at `preview/[service_id]/route.ts:54`
with a pointer to the new route, so the old path fails loudly and usefully
rather than 500-ing.

Group PDF preview populates `ResultDocumentInput.reportGroup` — a field that
already exists in `lib/results/types.ts:98` and is already honoured by the
renderer for real consolidated results. `orderedTests` is filled with the
group's mapped services. This is populating an existing path, not inventing one.
`resolvePerformer` currently takes `service: { code, kind }`; for a group
preview it is called with the group's code and a null kind, matching how the
existing per-service preview passes `kind: null`.

### 2. Generalised editor target

`TemplateEditor` is 758 lines and touches services in exactly four places:
three props (`serviceId`, `serviceCode`, `serviceName`), the `service_id` field
in the save payload, and the preview link at line 268.

Replace those with a discriminated target:

```ts
type TemplateTarget =
  | { kind: "service"; id: string; code: string; name: string }
  | { kind: "group";   id: string; code: string; name: string };
```

`TemplateEditorPayloadSchema` swaps `service_id: uuid` for
`target: { kind, id }`. `saveTemplateAndParamsAction` branches **only** on which
column it keys the `result_templates` row by (`service_id` vs
`report_group_id`) and which column it sets on insert. The parameter
reconciliation, age-band reconciliation, the `result_values` FK protection at
`actions.ts:104`, and the audit row are all unchanged and stay shared.

Existing per-service editing behaviour is unchanged. The XOR constraint
`result_templates_target_xor` from `0051` guarantees exactly one of the two
columns is set, so there is no ambiguity to resolve at runtime.

### 3. The group edit screen

Beyond the shared parameter editor, the screen carries four panels:

**Mapped services.** The services this template covers, by code and name, so an
admin can see the blast radius before saving. Each row flags misconfiguration:
inactive service, or a service marked `is_send_out` (which would be nonsense in
a group that requires in-house encoding).

**Superseded per-service templates.** The 12 unreachable deactivated templates,
labelled as superseded by the group template and explaining that reactivating
one does nothing because `queue/[id]` redirects past it. Offers deletion. This
is the trap the incident post-mortem specifically warns about — anyone told to
"reactivate the inactive chemistry templates" is being pointed at a no-op.

**Encoding-form preview.** Renders what the medtech's data-entry form will look
like for these parameters and this mapping, alongside the PDF preview. This is
the panel that matters most: the two-month failure was a broken *entry form*.
A PDF preview alone would not have made 13 missing fields obvious.

**Change history.** Recent `audit_log` rows for this template, showing who saved
it, when, and how the parameter count moved — so a drop from 14 to 1 is visible
in context rather than only discoverable by querying the audit log by hand.

### 4. Index page

- New **"Report groups"** section listing each group template with its layout,
  parameter count, mapped-service count, and Edit / Preview actions. Flags an
  active template with zero parameters as an error state.
- The 12 grouped services move out of "Eligible without template". Their
  **"+ Create"** button becomes **"Managed by Chemistry group →"**, linking to
  the group editor.

### 5. Service→parameter mapping moves into the database

New join table, one row per (service, template parameter) pair:

```sql
create table public.report_group_service_params (
  service_id   uuid not null references public.services(id)                  on delete cascade,
  parameter_id uuid not null references public.result_template_params(id)    on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (service_id, parameter_id)
);
```

RLS follows the `package_components` pattern from `0040` exactly: staff read
(`reception`, `medtech`, `pathologist`, `admin`, `xray_technician` — the
consolidated queue page reads through the user-scoped client, so medtech read
access is load-bearing), admin write.

Backfilled from the current `SERVICE_TO_PARAMS` map by matching
`parameter_name`, which naturally expands `Creatinine` and `Uric Acid` to both
their gendered rows — preserving today's behaviour exactly.
`LIPID_PROFILE_PACKAGE` gets **no rows**, preserving its billing-header
semantics (see above).

`consolidated-form.tsx` then derives `enabledParamNames` from data passed down
by its server page instead of the hardcoded map, and the map is deleted. Because
the link is now by `parameter_id`, renaming a parameter in the new editor can no
longer silently disable a field.

The mapping is editable on the group edit screen — each parameter shows which
services enable it, and the mapped-services panel shows which parameters each
service covers.

**Risk note.** `consolidated-form.tsx` is the file medtechs use every day and is
the riskiest change in this work. Mitigation: the backfill is behaviour-
preserving by construction (same pairs, derived from the same map), the
encoding-form preview panel gives a way to verify the rendered result without
touching a real patient's report, and the change is covered by unit tests over
the pure mapping-derivation logic.

### 6. Guardrail migration

Two triggers on `result_template_params`:

**Audit trigger** — statement-level `AFTER DELETE` with a transition table,
writing one `audit_log` row per affected template (grouping the transition
table by `template_id`): template id, count deleted, count remaining, and the
database role that did it. `audit_log.actor_id` is nullable
and `actor_type` is not, so these are written as `actor_type='system'` with a
null actor. Any future loss becomes traceable instead of silent.

**Opt-in guard** — `BEFORE DELETE` raising an exception unless the transaction
has explicitly set an opt-in flag (`app.allow_template_param_delete`, read via
`current_setting(..., true)`).

The flag mechanism must account for PostgREST: supabase-js runs **every call in
its own pooled transaction**, so a GUC set in one call is invisible to a
`.delete()` in the next. Application code therefore never sets the flag
directly — legitimate deletes go through `SECURITY DEFINER` RPCs that set the
flag transaction-locally (`set_config(..., true)`) and perform the delete in
the same transaction:

- `admin_delete_template_params(param_ids uuid[])` — called by the Save action
  in place of its current `.delete().in()`. The action's existing
  `result_values` reference check stays in the action, ahead of the RPC call.
- `admin_delete_result_template(template_id uuid)` — deleting a template row
  cascades into its params, which fires the guard; this RPC covers that path.
  Used by the superseded-template delete button on the new screen, and by
  `scripts/seed-result-templates.ts` (`clearExistingTemplate`), which today
  deletes templates through PostgREST and would otherwise break the day the
  guard ships.

Both RPCs are `REVOKE`d from `anon` and `authenticated` — service-role only —
so they add no new surface for the roles the release-lifecycle programme has
been locking down. Migrations that legitimately remove parameters use
`SET LOCAL app.allow_template_param_delete = 'on'` inside their own
transaction. The hand-run bulk delete that caused the incident, issued from a
SQL-editor session with no flag set, would have been blocked outright.

Deliberately **not** a "never let a template reach zero parameters" rule: the
actual incident left one row behind, so that rule would not have caught it and
would have offered false comfort.

There is no unique index on `(template_id, sort_order)` — only a plain index —
so the Save action's existing delete-then-insert ordering needs no change.

## Testing

- **Unit (vitest):** target-discrimination in the payload schema; derivation of
  enabled parameters from mapping rows, including the gendered-duplicate case
  and the package-header (zero-mapping) case. Modules under test must not
  `import "server-only"`.
- **Migration:** verified against production with a `BEGIN`/`ROLLBACK` dry run
  before the PR is opened — backfill row counts, the guard raising without the
  opt-in flag, and the guard passing with it.
- **Manual:** group edit screen loads and saves; PDF preview renders; encoding
  preview matches the real consolidated form; index shows the group and no
  longer offers "+ Create" on grouped services.

## Migration ordering

Migration numbering continues from `0117`. Per the repo's schema-change rules,
migrations are applied to the linked Supabase project before the PR preview will
pass, and `npm run db:types` is run afterwards.

## Out of scope, worth considering later

- Full report-group CRUD (see Non-goals).
- Extending the same guard pattern to `result_templates` itself — deactivating a
  template is currently as silent as emptying one was.
- A scheduled health check that reports template drift without waiting for an
  admin to open the index.
