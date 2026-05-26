import Link from "next/link";

type Tab = "income" | "balance" | "cashflow";

const TABS: { key: Tab; label: string; href: string }[] = [
  { key: "income", label: "Income statement", href: "/staff/admin/accounting/financial-statements" },
  { key: "balance", label: "Balance sheet", href: "/staff/admin/accounting/financial-statements/balance-sheet" },
  { key: "cashflow", label: "Cash flow", href: "/staff/admin/accounting/financial-statements/cash-flow" },
];

export function StatementTabs({ active }: { active: Tab }) {
  return (
    <nav className="mb-6 flex flex-wrap gap-2">
      {TABS.map((t) => {
        const isActive = t.key === active;
        return (
          <Link
            key={t.key}
            href={t.href}
            className={`min-h-11 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
              isActive
                ? "border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] text-white"
                : "border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)]"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
