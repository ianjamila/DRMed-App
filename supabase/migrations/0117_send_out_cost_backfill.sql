-- =============================================================================
-- 0117_send_out_cost_backfill.sql
-- =============================================================================
-- Data backfill. Until now NO service in the catalogue carried a send-out unit
-- cost — 0 of 83 — so 0064's costed COGS path had never executed and every
-- send-out release booked revenue with no matching cost of goods. This sets
-- send_out_unit_cost_php (and send_out_vendor_id → Hi Precision) for the 11
-- services whose per-test vendor charge can be evidenced from historical AP
-- bill lines.
--
-- WHERE THE FIGURES COME FROM
-- `bill_lines` rows against the Hi Precision vendor, restricted to lines naming
-- exactly ONE test (bundled lines like "HP: Vitamin D, Bicarbonate, Intact PTH"
-- are unusable — they carry a combined amount). Each figure repeated identically
-- across independent bill dates spanning 2026-01 to 2026-05, which is what makes
-- them trustworthy as a rate card rather than one-off quotes.
--
--   service code                              cost   samples  our price  margin
--   PERIPHERAL_SMEAR                          200      1        700       71%
--   EGFR                                      250      3      1,000       75%
--   PAP_SMEAR                                 300      5        750       60%
--   RPR_WITH_TITER_DILUTION                   350      3        850       59%
--   ESTRADIOL                               1,200      1      1,995       40%
--   VITAMIN_D_CMIA                          1,800      2      3,150       43%
--   ANTI_THYROXINE_PEROXIDASE_ANTI_TPO_AMA  2,000      1      3,000       33%
--   GENE_EXPERT                             2,545      4      4,000       36%
--   CT_NG_CHLAMYDIA_GONORRHEA_SWAB_AG       3,200      4      4,875       34%
--   CT_NG_CHLAMYDIA_GONORRHEA_URINE_AG      3,200      4      4,200       24%
--   HBV_DNA                                 4,400      2      5,940       26%
--
-- Every resulting margin lands in a plausible 24–75% band, which independently
-- corroborates that these are vendor costs. (It is also how we established that
-- ₱205 for Sodium was the sell price, not the cost — it would have implied 0%.)
--
-- ⚠ CONFIDENCE VARIES. PERIPHERAL_SMEAR, ESTRADIOL and ANTI_THYROXINE_PEROXIDASE
-- rest on a SINGLE observed bill line each; the other eight repeat 2–5 times.
-- Treat those three as provisional.
--
-- ⚠ THE SOURCE BILLS ARE ALL VOIDED. All 75 bills in the system were voided
-- during the books-reconciliation duplicate cleanup (the same spend was already
-- recorded through the history import). The bills are therefore not live
-- payables — but the amounts were transcribed from genuine Hi Precision invoices
-- and remain valid as reference costs. They are also 2026-01..2026-05 vintage and
-- may since have been repriced by the vendor.
--
-- ⚠ CT/NG: three distinct descriptions ("CT/NG Swab", "CT/NG Urine", "CT/NG Pap")
-- all bill at exactly ₱3,200, so ₱3,200 is the CT/NG rate regardless of specimen.
-- Swab and urine are separate catalogue services and both get it.
--
-- EFFECT ON THE LEDGER: from here, releasing any of these 11 appends
-- DR 6420 / CR 2150 for the unit cost to the release journal entry and writes a
-- cogs_send_out_entries row at that cost instead of at zero. Cost is snapshotted
-- at release, so later corrections here do NOT restate already-booked entries —
-- those need a cogs_send_out_trueups match. Already-released tests are untouched.
--
-- CORRECTING A FIGURE: no migration needed. An admin edits it at
-- /staff/admin/accounting/cogs/send-outs/unconfigured (updateSendOutConfig,
-- which writes a service.send_out_config_updated audit row).
--
-- NOT COVERED: the remaining 72 send-outs, including NA (Sodium) — no
-- single-test bill line evidences their cost. They keep NULL costs and continue
-- to appear on the unconfigured send-outs page.
--
-- Idempotent: the WHERE clause stops matching once applied, and each row is
-- addressed by service code.
-- =============================================================================

update public.services s
   set send_out_unit_cost_php = c.cost,
       send_out_vendor_id     = v.id
  from (values
    ('PERIPHERAL_SMEAR',                        200.00::numeric),
    ('EGFR',                                    250.00::numeric),
    ('PAP_SMEAR',                               300.00::numeric),
    ('RPR_WITH_TITER_DILUTION',                 350.00::numeric),
    ('ESTRADIOL',                             1200.00::numeric),
    ('VITAMIN_D_CMIA',                        1800.00::numeric),
    ('ANTI_THYROXINE_PEROXIDASE_ANTI_TPO_AMA', 2000.00::numeric),
    ('GENE_EXPERT',                           2545.00::numeric),
    ('CT_NG_CHLAMYDIA_GONORRHEA_SWAB_AG',     3200.00::numeric),
    ('CT_NG_CHLAMYDIA_GONORRHEA_URINE_AG',    3200.00::numeric),
    ('HBV_DNA',                               4400.00::numeric)
  ) as c(code, cost)
  cross join (select id from public.vendors where name = 'Hi Precision') v
 where s.code = c.code
   and s.is_send_out
   and (s.send_out_unit_cost_php is distinct from c.cost
     or s.send_out_vendor_id is distinct from v.id);

-- Guard: every one of the 11 must end up costed and attributed, or the backfill
-- is partial and some releases would silently keep booking at zero cost.
do $$
declare
  v_missing text;
  v_bad_vendor int;
begin
  select string_agg(c.code, ', ' order by c.code) into v_missing
    from (values
      ('PERIPHERAL_SMEAR'),('EGFR'),('PAP_SMEAR'),('RPR_WITH_TITER_DILUTION'),
      ('ESTRADIOL'),('VITAMIN_D_CMIA'),('ANTI_THYROXINE_PEROXIDASE_ANTI_TPO_AMA'),
      ('GENE_EXPERT'),('CT_NG_CHLAMYDIA_GONORRHEA_SWAB_AG'),
      ('CT_NG_CHLAMYDIA_GONORRHEA_URINE_AG'),('HBV_DNA')
    ) as c(code)
    left join public.services s
      on s.code = c.code and s.is_send_out
     and s.send_out_unit_cost_php is not null
     and s.send_out_unit_cost_php > 0
   where s.id is null;

  if v_missing is not null then
    raise exception 'send-out cost backfill incomplete for: %', v_missing;
  end if;

  select count(*) into v_bad_vendor
    from public.services s
    left join public.vendors v on v.id = s.send_out_vendor_id
   where s.send_out_unit_cost_php is not null
     and (v.name is distinct from 'Hi Precision');

  if v_bad_vendor > 0 then
    raise exception
      '% costed send-out(s) are not attributed to Hi Precision', v_bad_vendor;
  end if;
end $$;
