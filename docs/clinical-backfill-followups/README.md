# Clinical-backfill follow-ups — partner decision pack

Full design + runbook: [`docs/superpowers/specs/2026-06-11-clinical-backfill-followups.md`](../superpowers/specs/2026-06-11-clinical-backfill-followups.md).

These CSVs resolve the **439 held "ambiguous" clinical rows** from the v1.15.0 backfill —
transactions whose sheet name matches 2+ patient records that share a surname + first
name. The system will not guess which person each belongs to (RA 10173); the clinic
partner decides, one name-cluster at a time (~39 decisions unblock all 439 rows).

## Files

- **`ambiguous-worksheet.csv`** — one row per name-cluster. Columns: candidate patients
  side-by-side (DRM-ID / DOB / middle name / sex / phone / #visits), the system's
  `dedup_verdict`, a **non-binding** `hint` (SAME? / DISTINCT? / REVIEW / MANUAL) with its
  reason, and how many held lab/consult rows the cluster unblocks. **Read this first.**
- **`ambiguous-detail.csv`** — every held transaction (date, service, amount) grouped by
  cluster, to see what each cluster's labs/consults were when deciding DISTINCT ownership.
- **`cluster-resolutions.template.csv`** — the decision sheet to fill in.

## How to fill `cluster-resolutions.template.csv`

For each cluster set two columns:

| `decision` | `target_drm` | meaning |
|---|---|---|
| `SAME` | the survivor's DRM-ID | the candidates are the **same person** → merge the others into this one; the held rows import to it |
| `DISTINCT` | the owner's DRM-ID | the candidates are **different people** → keep them separate; the held rows belong to this one |
| `SKIP` | (blank) | undecided — leave the rows held |

Save it (e.g. as `cluster-resolutions.filled.csv`) and hand back to engineering to run the
gated merge + import (runbook in the spec). Partially-filled sheets are safe — only filled
rows are acted on.

> The `hint` column is guidance only (e.g. "birthdates 1 day apart — likely a typo",
> "Jr/Sr/III marker present"). The decision is the partner's.
