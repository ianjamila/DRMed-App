import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { SpecialtyGroup } from "@/lib/operations/daily-report";

const PESO = (n: number) =>
  new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(n);
const INT = (n: number) => new Intl.NumberFormat("en-PH").format(n);

/** Humanised compensation arrangement, shown as the reason a doctor's clinic sales are ₱0. */
function arrangementLabel(arrangement: string | null): string {
  switch (arrangement) {
    case "shareholder":
      return "Shareholder";
    case "rent_paying":
      return "Rent-paying";
    case "pf_split":
      return "PF split";
    default:
      return "—";
  }
}

export function DoctorPanel({ groups }: { groups: SpecialtyGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <Card className="mt-6 py-0">
      <details open>
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-[color:var(--color-brand-navy)]">
          Per-doctor &amp; per-specialty productivity
        </summary>
        <div className="border-t px-3 py-3">
          <p className="pb-3 text-xs text-[color:var(--color-brand-text-soft)]">
            Counts and PF measure productivity. Shareholder and rent-paying doctors keep 100%
            of the consult fee, so their clinic sales are ₱0 <em>by design</em> (their
            arrangement is tagged beside the name); for them &ldquo;Gross sales&rdquo; equals
            the PF that passes through to the doctor.
          </p>
          {groups.map((g) => (
            <div key={g.specialty} className="mb-4 last:mb-0">
              <div className="text-xs font-semibold tracking-wide text-[color:var(--color-brand-text-soft)] uppercase">
                {g.specialty}
              </div>
              <Table className="mt-1 text-xs">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="px-2 py-1 text-left font-medium">Doctor</TableHead>
                    <TableHead className="px-2 py-1 text-right font-medium">Consults</TableHead>
                    <TableHead className="px-2 py-1 text-right font-medium">Gross sales</TableHead>
                    <TableHead className="px-2 py-1 text-right font-medium">PF collected</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {g.doctors.map((d) => (
                    <TableRow key={d.physicianId ?? "unattributed"}>
                      <TableCell className="px-2 py-1">
                        {d.name}
                        {d.clinicZeroByDesign && (
                          <Badge
                            variant="secondary"
                            className="ml-2 bg-amber-100 text-amber-800"
                            title="Clinic keeps ₱0 of the consult — the fee passes to the doctor"
                          >
                            {arrangementLabel(d.arrangement)}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="px-2 py-1 text-right font-mono tabular-nums">
                        {INT(d.consultCount)}
                      </TableCell>
                      <TableCell className="px-2 py-1 text-right font-mono tabular-nums">
                        {PESO(d.salesGross)}
                      </TableCell>
                      <TableCell className="px-2 py-1 text-right font-mono tabular-nums">
                        {PESO(d.pfCollected)}
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="border-t-2 font-semibold hover:bg-transparent">
                    <TableCell className="px-2 py-1">Subtotal</TableCell>
                    <TableCell className="px-2 py-1 text-right font-mono tabular-nums">
                      {INT(g.consultCount)}
                    </TableCell>
                    <TableCell className="px-2 py-1 text-right font-mono tabular-nums">
                      {PESO(g.salesGross)}
                    </TableCell>
                    <TableCell className="px-2 py-1 text-right font-mono tabular-nums">
                      {PESO(g.pfCollected)}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          ))}
        </div>
      </details>
    </Card>
  );
}
