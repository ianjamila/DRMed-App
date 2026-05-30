import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  ALL_ROLES,
  DASHBOARD_CARDS,
  ROLE_LABELS,
  type DashboardRole,
} from "@/lib/dashboards/cards";
import { DashboardCardSettingsClient } from "./client";

export const metadata = { title: "Dashboard card settings — staff" };
export const dynamic = "force-dynamic";

interface PrefRow {
  role: string;
  card_id: string;
  visible: boolean;
}

interface SearchProps {
  searchParams: Promise<{ role?: string }>;
}

export default async function DashboardCardSettingsPage({
  searchParams,
}: SearchProps) {
  await requireAdminStaff();
  const sp = await searchParams;

  const role: DashboardRole = ALL_ROLES.includes(sp.role as DashboardRole)
    ? (sp.role as DashboardRole)
    : "admin";

  const admin = createAdminClient();
  const { data } = await admin
    .from("dashboard_card_prefs")
    .select("role, card_id, visible");
  const prefRows: PrefRow[] = data ?? [];

  // Hidden set per role
  const hiddenByRole: Record<DashboardRole, Set<string>> = {
    reception: new Set(),
    medtech: new Set(),
    xray_technician: new Set(),
    pathologist: new Set(),
    admin: new Set(),
  };
  for (const p of prefRows) {
    if (!p.visible && ALL_ROLES.includes(p.role as DashboardRole)) {
      hiddenByRole[p.role as DashboardRole].add(p.card_id);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <Link
          href="/staff"
          className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
        >
          ← Dashboard
        </Link>
        <h1 className="mt-3 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Dashboard card settings
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
          Hide sensitive cards from specific roles. When a card is hidden the
          underlying query is also skipped on the server — the data never
          reaches the browser. Cards flagged{" "}
          <span className="rounded-full bg-[color:var(--color-brand-cyan)]/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
            Sensitive
          </span>{" "}
          are good candidates to review first.
        </p>
      </header>

      <nav className="mb-6 flex flex-wrap gap-2">
        {ALL_ROLES.map((r) => {
          const active = role === r;
          const hiddenCount = hiddenByRole[r].size;
          return (
            <Link
              key={r}
              href={`/staff/admin/settings/dashboard-cards?role=${r}`}
              className={`min-h-11 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
                active
                  ? "border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-cyan)] text-white"
                  : "border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)]"
              }`}
            >
              {ROLE_LABELS[r]}
              {hiddenCount > 0 ? (
                <span
                  className={`ml-2 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                    active
                      ? "bg-white/20 text-white"
                      : "bg-amber-100 text-amber-900"
                  }`}
                >
                  {hiddenCount} hidden
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>

      <DashboardCardSettingsClient
        role={role}
        cards={DASHBOARD_CARDS.filter((c) => c.roles.includes(role)).map(
          (c) => ({
            id: c.id,
            label: c.label,
            group: c.group,
            sensitive: !!c.sensitive,
            visible: !hiddenByRole[role].has(c.id),
          }),
        )}
      />
    </div>
  );
}
