import { Check, ArrowRight } from "lucide-react";

import { PageHero } from "@/components/marketing/page-hero";
import { SectionHeading, PillLink } from "@/components/marketing/ui";
import { Reveal } from "@/components/marketing/motion";
import {
  listActivePackages,
  PACKAGE_GROUPS_ORDERED,
  type PackageGroup,
  type PackageWithGroup,
} from "@/lib/marketing/services";
import { formatPhp } from "@/lib/marketing/format";
import { pageMetadata } from "@/lib/marketing/metadata";

export const metadata = pageMetadata({
  title: "Diagnostic Packages & Checkup Bundles",
  description:
    "Affordable lab packages and annual checkup bundles at DRMed Clinic & Laboratory in Quezon City — up to 50% less than hospitals.",
  path: "/packages",
});

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
        title="Detailed Diagnostic"
        accent="Packages."
        description="Full package list with detailed inclusions and prices. Please confirm latest rates and availability before booking."
      />

      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
        {grouped.length === 0 ? (
          <Reveal>
            <p className="rounded-[20px] border border-dashed border-[color:var(--color-warm-line)] bg-[color:var(--color-warm-bg)] p-8 text-center text-sm text-[color:var(--color-ink-soft)]">
              Package list coming soon.
            </p>
          </Reveal>
        ) : (
          grouped.map(({ group, items }) => (
            <PackageGroupSection key={group} group={group} items={items} />
          ))
        )}

        {/* Bottom CTA bar */}
        <Reveal>
          <div className="mt-16 flex flex-wrap items-center justify-between gap-4 rounded-[20px] border border-[color:var(--color-warm-line-soft)] bg-[color:var(--color-warm-bg)] px-6 py-5">
            <p className="text-sm text-[color:var(--color-ink-mid)]">
              Need a specific test that isn&apos;t in a package?
            </p>
            <PillLink href="/all-services" variant="navy" size="sm">
              Check All Services <ArrowRight className="h-[18px] w-[18px]" />
            </PillLink>
          </div>
        </Reveal>

        <Reveal>
          <p className="mt-8 text-center text-xs text-[color:var(--color-ink-soft)]">
            Prices and inclusions may change without prior notice.
          </p>
        </Reveal>
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
    <section className="mb-16 sm:mb-20">
      <Reveal>
        <SectionHeading
          as="h2"
          title={group}
          className="mb-8"
        />
      </Reveal>
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((pkg, i) => (
          <Reveal key={pkg.id} delay={i * 0.06}>
            <article className="flex flex-col rounded-[20px] border border-[color:var(--color-warm-line-soft)] bg-white p-6 shadow-[var(--shadow-warm-sm)] transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-[var(--shadow-warm-lg)]">
              <h3 className="font-[family-name:var(--font-display)] text-xl leading-tight text-[color:var(--color-brand-navy)]">
                {pkg.name}
              </h3>

              <div className="mt-3">
                <span className="font-[family-name:var(--font-display)] italic text-2xl text-[color:var(--color-brand-cyan-text)]">
                  {formatPhp(pkg.price_php)}
                </span>
              </div>

              {pkg.inclusions.length > 0 ? (
                <ul className="mt-5 flex-1 space-y-2 border-t border-[color:var(--color-warm-line-soft)] pt-4">
                  {pkg.inclusions.map((item) => (
                    <li
                      key={item}
                      className="flex items-start gap-2 text-sm text-[color:var(--color-ink-mid)]"
                    >
                      <Check
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--color-brand-cyan)]"
                        aria-hidden="true"
                      />
                      {item}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-5 flex-1 border-t border-[color:var(--color-warm-line-soft)] pt-4 text-sm italic text-[color:var(--color-ink-soft)]">
                  Contact reception for inclusions.
                </p>
              )}

              <div className="mt-6 flex flex-wrap gap-2">
                <PillLink
                  href={`/all-services/${pkg.code.toLowerCase()}`}
                  variant="line"
                  size="sm"
                >
                  Details
                </PillLink>
                <PillLink
                  href="/#contact"
                  variant="navy"
                  size="sm"
                  className="flex-1"
                >
                  Book This Package
                </PillLink>
              </div>
            </article>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
