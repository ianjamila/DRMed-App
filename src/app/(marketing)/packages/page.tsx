import Link from "next/link";
import { PageHero } from "@/components/marketing/page-hero";
import {
  PACKAGES,
  PACKAGE_GROUPS_ORDERED,
  type PackageGroup,
} from "@/lib/marketing/packages";
import { formatPhp } from "@/lib/marketing/format";

export const metadata = {
  title: "Detailed Diagnostic Packages",
  description:
    "Full DRMed package list with detailed inclusions and prices. Confirm latest rates and availability before booking.",
};

export default function PackagesPage() {
  const grouped = PACKAGE_GROUPS_ORDERED.map((group) => ({
    group,
    items: PACKAGES.filter((p) => p.group === group),
  }));

  return (
    <>
      <PageHero
        eyebrow="DRMed Clinic and Laboratory"
        title="Detailed Diagnostic Packages"
        description="Full package list with detailed inclusions and prices. Please confirm latest rates and availability before booking."
      />

      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        {grouped.map(({ group, items }) => (
          <PackageGroupSection key={group} group={group} items={items} />
        ))}

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
  items: typeof PACKAGES;
}) {
  return (
    <section className="mb-16">
      <h2 className="mb-8 font-[family-name:var(--font-heading)] text-2xl font-extrabold text-[color:var(--color-brand-navy)] md:text-3xl">
        {group}
      </h2>
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((pkg) => (
          <article
            key={pkg.name}
            className="flex flex-col rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6 transition-shadow hover:shadow-md"
          >
            <h3 className="font-[family-name:var(--font-heading)] text-lg font-bold text-[color:var(--color-brand-navy)]">
              {pkg.name}
            </h3>
            <p className="mt-2 text-sm text-[color:var(--color-brand-text-soft)]">
              {pkg.description}
            </p>

            <div className="mt-4 flex items-baseline gap-2">
              {pkg.oldPricePhp ? (
                <span className="text-sm text-[color:var(--color-brand-text-soft)] line-through">
                  {formatPhp(pkg.oldPricePhp)}
                </span>
              ) : null}
              <span className="font-[family-name:var(--font-heading)] text-2xl font-extrabold text-[color:var(--color-brand-cyan)]">
                {formatPhp(pkg.pricePhp)}
              </span>
            </div>

            <ul className="mt-5 flex-1 space-y-1.5 border-t border-[color:var(--color-brand-bg-mid)] pt-4 text-sm text-[color:var(--color-brand-text-mid)]">
              {pkg.inclusions.map((item) => (
                <li key={item}>· {item}</li>
              ))}
            </ul>

            <Link
              href="/#contact"
              className="mt-6 inline-flex items-center justify-center rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-[color:var(--color-brand-cyan)]"
            >
              Book This Package
            </Link>
          </article>
        ))}
      </div>
    </section>
  );
}
