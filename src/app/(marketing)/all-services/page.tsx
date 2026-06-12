import { PageHero } from "@/components/marketing/page-hero";
import { listActiveServices } from "@/lib/marketing/services";
import { ServicesCatalog } from "./services-catalog";

export const metadata = {
  title: "Check All Services",
  description:
    "Searchable directory of every laboratory test, imaging study, vaccine, and consultation at DRMed Clinic & Laboratory.",
};

export default async function AllServicesPage() {
  const services = await listActiveServices();

  return (
    <>
      <PageHero
        eyebrow="Full Catalog"
        title="Check All Services"
        description="Search and filter every test, package, vaccine, and consultation we offer. For curated packages, see the Packages page; for service highlights, see the homepage."
      />

      <section className="py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          {services.length === 0 ? (
            <p className="rounded-[20px] border border-dashed border-[color:var(--color-warm-line)] bg-[color:var(--color-warm-bg)] p-8 text-center text-sm text-[color:var(--color-ink-soft)]">
              Service catalog coming soon. Please contact us for current
              availability.
            </p>
          ) : (
            <ServicesCatalog services={services} />
          )}
        </div>
      </section>

      <aside className="sticky bottom-0 border-t border-[color:var(--color-warm-line-soft)] bg-white/95 px-4 py-3 text-xs text-[color:var(--color-ink-soft)] backdrop-blur sm:px-6 lg:px-8">
        <p className="mx-auto max-w-7xl">
          Package pricing is shown above. Individual test and consultation
          prices are confirmed at reception so we can apply HMO, Senior/PWD
          (RA 9994 / 10754), and current promotional pricing correctly.
        </p>
      </aside>
    </>
  );
}
