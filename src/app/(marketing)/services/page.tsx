import Link from "next/link";
import { PageHero } from "@/components/marketing/page-hero";
import { formatPhp, listActiveServices } from "@/lib/marketing/services";

export const metadata = {
  title: "Services & Tests",
  description:
    "Full service and test catalog at DRMed Clinic & Laboratory — including blood chemistry, hematology, urinalysis, imaging, and more.",
};

export default async function ServicesPage() {
  const services = await listActiveServices();

  return (
    <>
      <PageHero
        eyebrow="Clinic & Lab Services"
        title="Services & Tests"
        description="Browse the full catalog of laboratory tests and clinical services. Prices may change without prior notice — final pricing confirmed at the clinic."
      />

      <section className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        {services.length === 0 ? (
          <p className="rounded-xl border border-dashed border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] p-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            Service catalog coming soon. Please contact us for current
            availability.
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {services.map((service) => (
              <li key={service.id}>
                <Link
                  href={`/services/${service.code.toLowerCase()}`}
                  className="group flex h-full flex-col rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5 transition-shadow hover:border-[color:var(--color-brand-cyan)] hover:shadow-md"
                >
                  <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
                    {service.code}
                  </p>
                  <h2 className="mt-1 font-[family-name:var(--font-heading)] text-lg font-bold text-[color:var(--color-brand-navy)] group-hover:text-[color:var(--color-brand-cyan)]">
                    {service.name}
                  </h2>
                  {service.description ? (
                    <p className="mt-2 line-clamp-2 text-sm text-[color:var(--color-brand-text-soft)]">
                      {service.description}
                    </p>
                  ) : null}
                  <div className="mt-4 flex items-center justify-between border-t border-[color:var(--color-brand-bg-mid)] pt-3 text-sm">
                    <span className="font-bold text-[color:var(--color-brand-navy)]">
                      {formatPhp(service.price_php)}
                    </span>
                    {service.turnaround_hours ? (
                      <span className="text-[color:var(--color-brand-text-soft)]">
                        {service.turnaround_hours}h turnaround
                      </span>
                    ) : null}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
