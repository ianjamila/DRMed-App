-- =============================================================================
-- 0076_historic_hmo_claims.sql
-- =============================================================================
-- 12.B sub-project — audit-only HMO claim ledger for historic xlsx import.
--
-- The live 12.3 HMO subledger (hmo_claim_items) hard-FKs to test_requests,
-- which hard-FKs to visits + patients. For the 4-year historic backfill we
-- don't synthesize those operational rows (free-text patient names, free-text
-- service names, ~4.3K HMO claims), so we use a parallel audit-only table.
--
-- Each row mirrors what the partner tracked in the xlsx HMO sections of the
-- DOCTOR CONSULTATION + LAB SERVICE tabs: provider, patient name, claim date,
-- amount, billing-cycle status, deadlines, and the eventual settlement date.
--
-- Joined to journal_entries via journal_entry_id so that:
--   * sum(final_amount_php) where status in ('pending','overdue') matches the
--     1110 AR-HMO control account net balance (sanity check at audit time);
--   * sum(final_amount_php) where status='paid' matches the VERITAS PAY
--     settlement total for the same period.
--
-- NOT integrated with /staff/admin/accounting/ar/hmo (which queries the live
-- subledger). Future audit views can query this table directly.
-- =============================================================================

create table public.historic_hmo_claims (
  id                      uuid primary key default gen_random_uuid(),

  -- Free-text HMO provider name as it appeared in the xlsx (col F of DOC tab,
  -- col F of LAB SERVICE). Normalized to title case on import.
  hmo_provider            text not null,

  -- Free-text patient name (LAST, FIRST format). Not FK'd to patients.
  patient_name            text not null,

  -- Service date / consultation date (xlsx col A).
  claim_date              date not null,

  -- Free-text service description (xlsx col H — doctor surname for consults,
  -- test name for labs).
  service_description     text,

  -- Pricing. base = sticker; final = base − discounts.
  base_amount_php         numeric(12,2) not null,
  final_amount_php        numeric(12,2) not null,

  -- Claim status as recorded by the partner. NOT necessarily current truth.
  -- Mapped from xlsx col V (consult) / col X (lab):
  --   PAID, paid    → 'paid'
  --   OVERDUE       → 'overdue'
  --   PENDING       → 'pending'
  --   blank/other   → 'unknown'
  status                  text not null check (status in ('paid', 'pending', 'overdue', 'unknown')),

  -- Submission and settlement dates from the xlsx HMO tracking columns.
  date_submitted          date,
  deadline_date           date,
  date_paid               date,

  -- OR # (official receipt) recorded by the partner when settled.
  or_number               text,

  -- Source provenance — which tab + row in DR MED MASTERSHEET.xlsx.
  source_tab              text not null check (source_tab in ('DOCTOR CONSULTATION', 'LAB SERVICE')),
  source_row              int not null,

  -- The accrual JE that booked this as DR 1110 AR-HMO. Nullable for rows where
  -- the JE failed or the row was rolled back.
  journal_entry_id        uuid references public.journal_entries(id) on delete set null,

  -- Free-text notes — xlsx remarks, import warnings, etc.
  notes                   text,

  imported_at             timestamptz not null default now(),

  constraint historic_hmo_claims_amounts_nonneg
    check (base_amount_php >= 0 and final_amount_php >= 0),
  constraint historic_hmo_claims_final_le_base
    check (final_amount_php <= base_amount_php),
  constraint historic_hmo_claims_source_unique
    unique (source_tab, source_row)
);

create index idx_historic_hmo_claims_provider on public.historic_hmo_claims (hmo_provider);
create index idx_historic_hmo_claims_status on public.historic_hmo_claims (status);
create index idx_historic_hmo_claims_claim_date on public.historic_hmo_claims (claim_date);
create index idx_historic_hmo_claims_outstanding
  on public.historic_hmo_claims (hmo_provider, claim_date)
  where status in ('pending', 'overdue');

alter table public.historic_hmo_claims enable row level security;

create policy "historic_hmo_claims: admin read"
  on public.historic_hmo_claims
  for select to authenticated
  using (public.has_role(array['admin']));
