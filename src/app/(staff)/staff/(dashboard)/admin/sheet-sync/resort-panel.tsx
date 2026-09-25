// The re-sort panel (?view=resort). `sheet_resort_candidates` is
// service-role only (0170: revoked from anon/authenticated, granted only to
// service_role) — read it through the admin client, safe here only because
// page.tsx already ran requireAdminStaff() before rendering this view, the
// same trust boundary approveResortGroupAction (actions.ts) uses for the
// same RPC.
import { createAdminClient } from "@/lib/supabase/admin";
import { createSupabaseStore, type SheetSyncStore } from "@/lib/sheet-sync/store";
import { computeResortGroups } from "@/lib/sheet-sync/resort";
import { Panel } from "@/components/ui/panel";
import { REFERRAL_NOT_RECORDED_LABEL, referralSourceLabel } from "@/lib/patients/referral-sources";
import { ApproveResortGroupButton } from "./review-actions";

export async function ResortPanel() {
  const store = createSupabaseStore(createAdminClient());

  // No error.tsx above this route segment — an unhandled throw here (a DB
  // error, or the loaders' own row-ceiling error) would take down the whole
  // admin page, not just this panel. Match ReviewQueue's load-failure shape.
  let candidates: Awaited<ReturnType<SheetSyncStore["resortCandidates"]>>;
  let aliases: Awaited<ReturnType<SheetSyncStore["loadAliases"]>>;
  try {
    [candidates, aliases] = await Promise.all([store.resortCandidates(), store.loadAliases()]);
  } catch (e) {
    console.error("sheet sync resort panel load failed", e);
    return (
      <p className="text-sm text-red-600" role="alert">
        Could not load the re-sort groups. Try refreshing the page.
      </p>
    );
  }

  const { groups, keptByStaff } = computeResortGroups(candidates, aliases);

  return (
    <div className="space-y-4">
      <Panel className="p-5 text-sm text-[color:var(--color-brand-text-mid)]">
        <p>
          Patients imported from the sheet in May were sorted by an older, rougher list. These groups show what the
          new list would change. Nothing changes until you approve a group. Each approval can be undone from Run
          history.
        </p>
      </Panel>

      <Panel className="overflow-x-auto p-0">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[color:var(--color-brand-bg-mid)] text-xs font-semibold uppercase tracking-wide text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-3 py-2">Answer as typed (sample)</th>
              <th className="px-3 py-2">Now</th>
              <th className="px-3 py-2">Proposed</th>
              <th className="px-3 py-2">Patients</th>
              <th className="px-3 py-2">Approve</th>
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-[color:var(--color-brand-text-soft)]">
                  Nothing to re-sort right now.
                </td>
              </tr>
            ) : (
              groups.map((g) => {
                const fromLabel = referralSourceLabel(g.from) ?? REFERRAL_NOT_RECORDED_LABEL;
                const toLabel = g.to ? (referralSourceLabel(g.to) ?? g.to) : REFERRAL_NOT_RECORDED_LABEL;
                return (
                  <tr key={`${g.answerNorm}\u0000${g.from}\u0000${g.to}`} className="border-b border-[color:var(--color-brand-bg-mid)] align-top last:border-0">
                    <td className="px-3 py-2">&ldquo;{g.sampleAnswer}&rdquo;</td>
                    <td className="px-3 py-2 whitespace-nowrap">{fromLabel}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{toLabel}</td>
                    <td className="px-3 py-2">{g.patientIds.length}</td>
                    <td className="px-3 py-2">
                      <ApproveResortGroupButton
                        answerNorm={g.answerNorm}
                        from={g.from}
                        to={g.to}
                        patientCount={g.patientIds.length}
                        sampleAnswer={g.sampleAnswer}
                        fromLabel={fromLabel}
                        toLabel={toLabel}
                      />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </Panel>

      <p className="text-xs text-[color:var(--color-brand-text-soft)]">
        {keptByStaff} patient{keptByStaff === 1 ? "" : "s"} were changed by staff since the import and are left
        alone.
      </p>
    </div>
  );
}
