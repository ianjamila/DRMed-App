import type { SpecialtyGroup } from "@/lib/operations/daily-report";

const PESO = (n: number) =>
  new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(n);
const INT = (n: number) => new Intl.NumberFormat("en-PH").format(n);

export function DoctorPanel({ groups }: { groups: SpecialtyGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <details className="mt-6 rounded-lg border bg-white shadow-sm" open>
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-[color:var(--color-brand-navy)]">
        Per-doctor &amp; per-specialty productivity
      </summary>
      <div className="border-t px-2 py-2">
        <p className="px-2 pb-2 text-xs text-[color:var(--color-brand-text-soft)]">
          Counts and PF measure productivity. Shareholder / rent doctors keep 100% of the
          consult fee, so their clinic sales are ₱0 <em>by design</em> (flagged below).
        </p>
        {groups.map((g) => (
          <div key={g.specialty} className="mb-3">
            <div className="px-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-brand-text-soft)]">
              {g.specialty}
            </div>
            <table className="mt-1 w-full text-xs">
              <thead>
                <tr className="text-left text-[color:var(--color-brand-text-soft)]">
                  <th className="px-2 py-1">Doctor</th>
                  <th className="px-2 py-1 text-right">Consults</th>
                  <th className="px-2 py-1 text-right">Clinic sales</th>
                  <th className="px-2 py-1 text-right">PF collected</th>
                </tr>
              </thead>
              <tbody>
                {g.doctors.map((d) => (
                  <tr key={d.physicianId ?? "unattributed"} className="border-t">
                    <td className="px-2 py-1">
                      {d.name}
                      {d.clinicZeroByDesign && (
                        <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800">
                          clinic ₱0 by design
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1 text-right font-mono">{INT(d.consultCount)}</td>
                    <td className="px-2 py-1 text-right font-mono">{PESO(d.salesGross)}</td>
                    <td className="px-2 py-1 text-right font-mono">{PESO(d.pfCollected)}</td>
                  </tr>
                ))}
                <tr className="border-t-2 font-semibold">
                  <td className="px-2 py-1">Subtotal</td>
                  <td className="px-2 py-1 text-right font-mono">{INT(g.consultCount)}</td>
                  <td className="px-2 py-1 text-right font-mono">{PESO(g.salesGross)}</td>
                  <td className="px-2 py-1 text-right font-mono">{PESO(g.pfCollected)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </details>
  );
}
