import Link from "next/link";
import { PageHero } from "@/components/marketing/page-hero";
import {
  listActivePackages,
  PACKAGE_GROUPS_ORDERED,
  type PackageGroup,
  type PackageWithGroup,
} from "@/lib/marketing/services";
import { formatPhp } from "@/lib/marketing/format";

export const metadata = {
  title: "Detailed Diagnostic Packages",
  description:
    "Full DRMed package list with detailed inclusions and prices. Confirm latest rates and availability before booking.",
};

// Live data — admin price changes on /staff/admin/prices reflect here on next
// request because lab_package rows are read directly from the services table.
export const dynamic = "force-dynamic";

export default async function PackagesPage() {
  const packages = await listActivePackages();
  const grouped = PACKAGE_GROUPS_ORDERED.map((group) => ({
    group,
    items: packages.filter((p) => p.group === group),
  })).filter((g) => g.items.length > 0);

  return (
    <>
      <PageHero
        eyebrow="DRMed Clinic and Laboratory"
        title="Detailed Diagnostic Packages"
        description="Full package list with detailed inclusions and prices. Please confirm latest rates and availability before booking."
      />

      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        {grouped.length === 0 ? (
          <p className="rounded-xl border border-dashed border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] p-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            Package list coming soon.
          </p>
        ) : (
          grouped.map(({ group, items }) => (
            <PackageGroupSection key={group} group={group} items={items} />
          ))
        )}

        <div className="mt-16 flex flex-wrap items-center justify-center gap-3 rounded-2xl border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] px-6 py-5 text-center">
          <p className="text-sm text-[color:var(--color-brand-text-mid)]">
            Need a specific test that isn&apos;t in a package?
          </p>
          <Link
            href="/all-services"
            className="rounded-md bg-[color:var(--color-brand-navy)] px-5 py-2 text-sm font-bold text-white transition-colors hover:bg-[color:var(--color-brand-cyan)]"
          >
            Check All Services →
          </Link>
        </div>

        <p className="mt-12 text-center text-xs text-[color:var(--color-brand-text-soft)]">
          Prices and inclusions may change without prior notice.
        </p>
      </div>
    </>
  );
}

function PackageGroupSection({
  group,
  items,
}: {
  group: PackageGroup;
  items: PackageWithGroup[];
}) {
  return (
    <section className="mb-16">
      <h2 className="mb-8 font-[family-name:var(--font-heading)] text-2xl font-extrabold text-[color:var(--color-brand-navy)] md:text-3xl">
        {group}
      </h2>
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((pkg) => (
          <article
            key={pkg.id}
            className="flex flex-col rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6 transition-shadow hover:shadow-md"
          >
            <h3 className="font-[family-name:var(--font-heading)] text-lg font-bold text-[color:var(--color-brand-navy)]">
              {pkg.name}
            </h3>

            <div className="mt-4 flex items-baseline gap-2">
              <span className="font-[family-name:var(--font-heading)] text-2xl font-extrabold text-[color:var(--color-brand-cyan)]">
                {formatPhp(pkg.price_php)}
              </span>
            </div>

            {pkg.inclusions.length > 0 ? (
              <ul className="mt-5 flex-1 space-y-1.5 border-t border-[color:var(--color-brand-bg-mid)] pt-4 text-sm text-[color:var(--color-brand-text-mid)]">
                {pkg.inclusions.map((item) => (
                  <li key={item}>· {item}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-5 flex-1 border-t border-[color:var(--color-brand-bg-mid)] pt-4 text-sm italic text-[color:var(--color-brand-text-soft)]">
                Contact reception for inclusions.
              </p>
            )}

            <div className="mt-6 flex flex-wrap gap-2">
              <Link
                href={`/all-services/${pkg.code.toLowerCase()}`}
                className="inline-flex items-center justify-center rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2.5 text-xs font-bold text-[color:var(--color-brand-navy)] transition-colors hover:border-[color:var(--color-brand-cyan)] hover:text-[color:var(--color-brand-cyan)]"
              >
                Details
              </Link>
              <Link
                href="/#contact"
                className="inline-flex flex-1 items-center justify-center rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-[color:var(--color-brand-cyan)]"
              >
                Book This Package
              </Link>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
