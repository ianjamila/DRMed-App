import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";

export const metadata = { title: "HMO providers — staff" };

export const dynamic = "force-dynamic";

export default async function HmoProvidersIndex() {
  await requireAdminStaff();
  const admin = createAdminClient();

  const { data: providers } = await admin
    .from("hmo_providers")
    .select(
      "id, name, is_active, due_days_for_invoice, contract_end_date, contact_person_name, contact_person_phone",
    )
    .order("is_active", { ascending: false })
    .order("name", { ascending: true });

  const active = (providers ?? []).filter((p) => p.is_active);
  const inactive = (providers ?? []).filter((p) => !p.is_active);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
            Phase 7B · Admin
          </p>
          <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            HMO providers
          </h1>
          <p className="mt-2 max-w-xl text-sm text-[color:var(--color-brand-text-soft)]">
            Maintained list reception picks from when capturing HMO
            authorisation on a visit. Contract metadata feeds the upcoming HMO
            receivables dashboard (Phase 12).
          </p>
        </div>
        <Link
          href="/staff/admin/hmo-providers/new"
          className="shrink-0 rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          + New provider
        </Link>
      </header>

      <Section title={`Active (${active.length})`} rows={active} />

      {inactive.length > 0 ? (
        <Section
          title={`Inactive (${inactive.length})`}
          rows={inactive}
          muted
        />
      ) : null}
    </div>
  );
}

interface ProviderRow {
  id: string;
  name: string;
  is_active: boolean;
  due_days_for_invoice: number | null;
  contract_end_date: string | null;
  contact_person_name: string | null;
  contact_person_phone: string | null;
}

function Section({
  title,
  rows,
  muted = false,
}: {
  title: string;
  rows: ProviderRow[];
  muted?: boolean;
}) {
  return (
    <section className="mt-2">
      <h2 className="font-[family-name:var(--font-heading)] text-sm font-extrabold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {title}
      </h2>
      {rows.length === 0 ? (
        <p className="mt-2 rounded-lg border border-dashed border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-3 text-sm text-[color:var(--color-brand-text-soft)]">
          No providers yet.
        </p>
      ) : (
        <ul
          className={`mt-2 divide-y divide-[color:var(--color-brand-bg-mid)] rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white ${
            muted ? "opacity-60" : ""
          }`}
        >
          {rows.map((p) => (
            <li
              key={p.id}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate font-semibold text-[color:var(--color-brand-navy)]">
                  {p.name}
                </p>
                <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                  {p.due_days_for_invoice != null
                    ? `${p.due_days_for_invoice}-day terms`
                    : "no terms set"}
                  {p.contract_end_date ? ` · ends ${p.contract_end_date}` : ""}
                  {p.contact_person_name
                    ? ` · ${p.contact_person_name}`
                    : ""}
                  {p.contact_person_phone ? ` · ${p.contact_person_phone}` : ""}
                </p>
              </div>
              <Link
                href={`/staff/admin/hmo-providers/${p.id}/edit`}
                className="shrink-0 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]"
              >
                Edit
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
