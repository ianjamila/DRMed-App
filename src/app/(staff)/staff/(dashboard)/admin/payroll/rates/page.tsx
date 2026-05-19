import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { todayManilaISODate } from "@/lib/dates/manila";
import {
  RatesClient,
  type ContributionBracketRow,
  type RateKind,
  type WtBracketRow,
} from "./rates-client";

export const metadata = { title: "Statutory rates — payroll admin" };
export const dynamic = "force-dynamic";

const ALL_KINDS: ReadonlySet<RateKind> = new Set<RateKind>([
  "sss",
  "philhealth",
  "pagibig",
  "wt",
]);

const CONTRIBUTION_KINDS: ReadonlyArray<Exclude<RateKind, "wt">> = [
  "sss",
  "philhealth",
  "pagibig",
];

interface PageProps {
  searchParams: Promise<Record<string, string | undefined>>;
}

export default async function PayrollRatesPage({ searchParams }: PageProps) {
  await requireAdminStaff();
  const sp = await searchParams;

  const kindParam = sp.kind ?? "sss";
  const kind: RateKind = ALL_KINDS.has(kindParam as RateKind)
    ? (kindParam as RateKind)
    : "sss";

  // Service-role client to keep these reads simple — page is admin-only via
  // requireAdminStaff() above.
  const admin = createAdminClient();
  const todayManila = todayManilaISODate();

  let dbError: string | null = null;
  let contributionRows: ContributionBracketRow[] = [];
  let wtRows: WtBracketRow[] = [];

  if (kind === "wt") {
    const { data, error } = await admin
      .from("payroll_wt_brackets")
      .select(
        "id, effective_from, effective_to, taxable_min_php, taxable_max_php, base_tax_php, marginal_rate, notes",
      )
      .order("effective_from", { ascending: false })
      .order("taxable_min_php", { ascending: true });
    if (error) {
      console.error("[payroll/rates] wt query failed:", error);
      dbError = "Failed to load WT brackets.";
    }
    wtRows = (data ?? []).map((r) => ({
      id: r.id,
      effective_from: r.effective_from,
      effective_to: r.effective_to,
      taxable_min_php: Number(r.taxable_min_php),
      taxable_max_php:
        r.taxable_max_php === null ? null : Number(r.taxable_max_php),
      base_tax_php: Number(r.base_tax_php),
      marginal_rate: Number(r.marginal_rate),
      notes: r.notes,
    }));
  } else {
    const { data, error } = await admin
      .from("payroll_contribution_brackets")
      .select(
        "id, kind, effective_from, effective_to, monthly_salary_credit_min_php, monthly_salary_credit_max_php, employee_share_php, employer_share_php, notes",
      )
      .eq("kind", kind)
      .order("effective_from", { ascending: false })
      .order("monthly_salary_credit_min_php", { ascending: true });
    if (error) {
      console.error("[payroll/rates] contribution query failed:", error);
      dbError = "Failed to load contribution brackets.";
    }
    contributionRows = (data ?? []).map((r) => ({
      id: r.id,
      kind: r.kind,
      effective_from: r.effective_from,
      effective_to: r.effective_to,
      monthly_salary_credit_min_php: Number(r.monthly_salary_credit_min_php),
      monthly_salary_credit_max_php: Number(r.monthly_salary_credit_max_php),
      employee_share_php: Number(r.employee_share_php),
      employer_share_php: Number(r.employer_share_php),
      notes: r.notes,
    }));
  }

  // Active-bracket counts for the four tab badges. "Active" means
  // effective_to IS NULL — the row is currently in effect. We issue four
  // tiny HEAD-only count queries in parallel; cheap and avoids dragging
  // every row across the wire just to derive a badge.
  type CountResult = { kind: RateKind; count: number };
  const countResults = await Promise.all<CountResult>([
    ...CONTRIBUTION_KINDS.map(async (k) => {
      const { count, error } = await admin
        .from("payroll_contribution_brackets")
        .select("id", { count: "exact", head: true })
        .eq("kind", k)
        .is("effective_to", null);
      if (error) {
        console.error(`[payroll/rates] ${k} count query failed:`, error);
      }
      return { kind: k, count: count ?? 0 };
    }),
    (async () => {
      const { count, error } = await admin
        .from("payroll_wt_brackets")
        .select("id", { count: "exact", head: true })
        .is("effective_to", null);
      if (error) {
        console.error("[payroll/rates] wt count query failed:", error);
      }
      return { kind: "wt" as const, count: count ?? 0 };
    })(),
  ]);
  const activeCounts: Record<RateKind, number> = {
    sss: 0,
    philhealth: 0,
    pagibig: 0,
    wt: 0,
  };
  for (const r of countResults) {
    activeCounts[r.kind] = r.count;
  }

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Statutory rates
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          SSS, PhilHealth, Pag-IBIG and Withholding Tax brackets used by the
          payroll compute engine. Effective-from is when the bracket takes
          effect; effective-to is null while it is current.
        </p>
      </header>

      <RatesClient
        kind={kind}
        contributionBrackets={contributionRows}
        wtBrackets={wtRows}
        activeCounts={activeCounts}
        todayManila={todayManila}
        error={dbError}
      />
    </div>
  );
}
