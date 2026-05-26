import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminStaff } from "@/lib/auth/require-admin";

export const dynamic = "force-dynamic";

interface PlannedModule {
  label: string;
  description: string;
  audience: string;
  highlights: string[];
}

const MODULES: Record<string, PlannedModule> = {
  inventory: {
    label: "Inventory",
    description:
      "Reagent stock, expiry tracking, reorder thresholds, and critical-supply alerts across lab sections and front-desk consumables.",
    audience: "Lab and Admin",
    highlights: [
      "Per-section reagent stock balances",
      "Expiry-soon list (configurable days-out)",
      "Reorder thresholds with low-stock alerts",
      "Receiving + issue movements with audit trail",
    ],
  },
  "financial-statements": {
    label: "Financial statements",
    description:
      "Profit & loss, balance sheet, and cash flow statements generated directly from the chart of accounts and posted journal entries.",
    audience: "Admin",
    highlights: [
      "P&L for any date range with period-over-period comparison",
      "Balance sheet snapshot as of a point in time",
      "Cash flow waterfall (operating / investing / financing)",
      "Drill from line item back to source journal entry",
    ],
  },
  "variance-analysis": {
    label: "Budget vs actual / variance analysis",
    description:
      "Set department budgets, track actuals against plan, and decompose variances into drivers with narrative commentary.",
    audience: "Admin",
    highlights: [
      "Per-account or per-cost-centre budgets",
      "Monthly actual vs budget with variance %",
      "Waterfall view of variance drivers",
      "Forecast reforecasting based on YTD trend",
    ],
  },
  "bank-reconciliation": {
    label: "Bank reconciliation",
    description:
      "Match bank statement transactions against the GL cash accounts, surface unmatched items, and track running variance to date.",
    audience: "Admin",
    highlights: [
      "Import bank statements (CSV / OFX)",
      "Auto-match by amount + date with manual override",
      "Unmatched-items aging list",
      "Per-account reconciliation status dashboard",
    ],
  },
  "close-tracker": {
    label: "Month-end close tracker",
    description:
      "Interactive close checklist that sequences tasks, tracks status, and captures sign-off for a clean month-end.",
    audience: "Admin",
    highlights: [
      "Configurable close-task templates",
      "Per-task owner, due date, and dependency",
      "Status board for the current close cycle",
      "Audit trail of who signed off on which task",
    ],
  },
  "send-out-performance": {
    label: "Send-out vendor performance",
    description:
      "Per-vendor turnaround time, cost variance, SLA compliance, and rejection rate — a scorecard for managing external lab partners.",
    audience: "Lab and Admin",
    highlights: [
      "Median + p95 TAT per send-out vendor",
      "Cost variance vs the locked-in unit cost",
      "SLA compliance rate per vendor + section",
      "Rejection / re-do rate trend",
    ],
  },
  "tat-analytics": {
    label: "Turnaround analytics",
    description:
      "Per-section turnaround-time analytics with SLA-breach surfacing and historical trends.",
    audience: "Lab and Admin",
    highlights: [
      "Median TAT per section + per test",
      "SLA-breach list (current + last 30 days)",
      "Trend chart over rolling 90 days",
      "Drill from outlier to the specific test request",
    ],
  },
};

interface PageProps {
  params: Promise<{ module: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { module: slug } = await params;
  const mod = MODULES[slug];
  return {
    title: mod ? `${mod.label} — coming soon` : "Coming soon",
  };
}

export default async function ComingSoonPage({ params }: PageProps) {
  await requireAdminStaff();
  const { module: slug } = await params;
  const mod = MODULES[slug];

  if (!mod) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/staff"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Dashboard
      </Link>
      <header className="mt-3">
        <span className="inline-flex items-center rounded-full bg-[color:var(--color-brand-cyan)]/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          Planned
        </span>
        <h1 className="mt-3 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          {mod.label}
        </h1>
        <p className="mt-1 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          For {mod.audience}
        </p>
        <p className="mt-3 text-base text-[color:var(--color-brand-text)]">
          {mod.description}
        </p>
      </header>

      <section className="mt-8 rounded-xl border border-dashed border-[color:var(--color-brand-cyan-light)] bg-[color:var(--color-brand-bg)] p-6">
        <h2 className="font-[family-name:var(--font-heading)] text-sm font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          What this module will include
        </h2>
        <ul className="mt-4 space-y-2">
          {mod.highlights.map((h) => (
            <li
              key={h}
              className="flex items-start gap-2 text-sm text-[color:var(--color-brand-text)]"
            >
              <span
                aria-hidden
                className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--color-brand-cyan)]"
              />
              <span>{h}</span>
            </li>
          ))}
        </ul>
      </section>

      <p className="mt-6 text-sm text-[color:var(--color-brand-text-soft)]">
        This module isn&apos;t built yet. The placeholder exists so the
        dashboard tile has somewhere to land and so we can scope the work when
        it&apos;s prioritised.
      </p>
    </div>
  );
}
