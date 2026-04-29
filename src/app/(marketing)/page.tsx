import Link from "next/link";
import {
  CONTACT,
  HERO_STATS,
  PACKAGE_GROUPS,
  SERVICE_HIGHLIGHTS,
  SITE,
  TRUST_BAR,
} from "@/lib/marketing/site";

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "MedicalBusiness",
  name: SITE.name,
  url: SITE.url,
  email: CONTACT.email,
  telephone: CONTACT.phone.mobileE164,
  address: {
    "@type": "PostalAddress",
    streetAddress: `${CONTACT.address.line1}, ${CONTACT.address.line2}`,
    addressLocality: CONTACT.address.city,
    addressRegion: CONTACT.address.region,
    addressCountry: CONTACT.address.country,
  },
  openingHours: "Mo-Sa 08:00-17:00",
  medicalSpecialty: ["Diagnostic", "ClinicalLaboratory", "Radiology"],
};

export default function HomePage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      {/* Hero ----------------------------------------------------------- */}
      <section className="relative overflow-hidden bg-gradient-to-b from-[color:var(--color-brand-bg)] to-white">
        <div className="mx-auto grid max-w-7xl gap-12 px-4 py-16 sm:px-6 md:py-24 lg:grid-cols-2 lg:px-8 lg:py-28">
          <div>
            <p className="mb-4 inline-flex items-center gap-3 text-xs font-bold uppercase tracking-[0.18em] text-[color:var(--color-brand-cyan)]">
              <span className="h-px w-8 bg-[color:var(--color-brand-cyan)]" />
              Premier Diagnostic Care · Quezon City
            </p>
            <h1 className="font-[family-name:var(--font-heading)] text-4xl font-extrabold leading-tight text-[color:var(--color-brand-navy)] sm:text-5xl md:text-6xl">
              Your Family&apos;s
              <br />
              Well-Being is{" "}
              <span className="text-[color:var(--color-brand-cyan)]">
                Our Mission.
              </span>
            </h1>
            <p className="mt-6 max-w-xl text-base text-[color:var(--color-brand-text-mid)] md:text-lg">
              {SITE.description}
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/services"
                className="rounded-md bg-[color:var(--color-brand-navy)] px-6 py-3 text-sm font-bold text-white shadow-md transition-colors hover:bg-[color:var(--color-brand-cyan)]"
              >
                View Services
              </Link>
              <Link
                href="/portal/login"
                className="rounded-md border-2 border-[color:var(--color-brand-navy)] bg-white px-6 py-3 text-sm font-bold text-[color:var(--color-brand-navy)] transition-colors hover:bg-[color:var(--color-brand-navy)] hover:text-white"
              >
                Access My Results
              </Link>
            </div>

            <dl className="mt-12 grid grid-cols-2 gap-6 border-t border-[color:var(--color-brand-bg-mid)] pt-8 sm:grid-cols-4">
              {HERO_STATS.map((stat) => (
                <div key={stat.label}>
                  <dt className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
                    {stat.value}
                  </dt>
                  <dd className="mt-1 text-xs font-medium leading-tight text-[color:var(--color-brand-text-soft)]">
                    {stat.label}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="relative hidden lg:block">
            <div className="absolute -inset-4 rounded-3xl bg-gradient-to-br from-[color:var(--color-brand-cyan)] to-[color:var(--color-brand-navy)] opacity-10 blur-2xl" />
            <div className="relative grid h-full grid-rows-2 gap-4">
              <div className="rounded-2xl bg-[color:var(--color-brand-navy)] p-8 text-white shadow-xl">
                <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
                  Accredited Facility
                </p>
                <p className="mt-2 font-[family-name:var(--font-heading)] text-3xl font-extrabold">
                  10 HMO Partners
                </p>
                <p className="mt-2 text-sm text-white/70">
                  Cashless · No hassle
                </p>
              </div>
              <div className="rounded-2xl border border-[color:var(--color-brand-bg-mid)] bg-white p-8 shadow-xl">
                <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
                  Average Turnaround
                </p>
                <p className="mt-2 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
                  24 Hours
                </p>
                <p className="mt-2 text-sm text-[color:var(--color-brand-text-soft)]">
                  Most tests same-day
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Trust bar ------------------------------------------------------ */}
      <section className="border-y border-[color:var(--color-brand-bg-mid)] bg-white">
        <div className="mx-auto grid max-w-7xl gap-6 px-4 py-8 sm:px-6 md:grid-cols-3 lg:grid-cols-5 lg:px-8">
          {TRUST_BAR.map((item) => (
            <div key={item.title} className="flex items-center gap-3">
              <span className="text-2xl" aria-hidden>
                {item.icon}
              </span>
              <div>
                <p className="text-sm font-bold text-[color:var(--color-brand-navy)]">
                  {item.title}
                </p>
                <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                  {item.sub}
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Services ------------------------------------------------------- */}
      <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
        <div className="mb-12 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="mb-2 inline-flex items-center gap-3 text-xs font-bold uppercase tracking-[0.18em] text-[color:var(--color-brand-cyan)]">
              <span className="h-px w-8 bg-[color:var(--color-brand-cyan)]" />
              Clinic & Lab Services
            </p>
            <h2 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)] md:text-5xl">
              Everything Under
              <br />
              <span className="text-[color:var(--color-brand-cyan)]">
                One Roof
              </span>
            </h2>
          </div>
          <Link
            href="/services"
            className="rounded-md bg-[color:var(--color-brand-navy)] px-5 py-2.5 text-sm font-bold text-white transition-colors hover:bg-[color:var(--color-brand-cyan)]"
          >
            View All Services →
          </Link>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {SERVICE_HIGHLIGHTS.map((service) => (
            <article
              key={service.name}
              className="group rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6 transition-shadow hover:shadow-lg"
            >
              <span className="text-3xl" aria-hidden>
                {service.icon}
              </span>
              <h3 className="mt-4 font-[family-name:var(--font-heading)] text-lg font-bold text-[color:var(--color-brand-navy)]">
                {service.name}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-[color:var(--color-brand-text-soft)]">
                {service.desc}
              </p>
              <p className="mt-4 text-sm font-bold text-[color:var(--color-brand-cyan)]">
                {service.price}
              </p>
            </article>
          ))}
        </div>
      </section>

      {/* Packages ------------------------------------------------------- */}
      <section className="bg-[color:var(--color-brand-navy)] text-white">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
          <div className="mb-12 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="mb-2 inline-flex items-center gap-3 text-xs font-bold uppercase tracking-[0.18em] text-[color:var(--color-brand-cyan)]">
                <span className="h-px w-8 bg-[color:var(--color-brand-cyan)]" />
                Health Packages
              </p>
              <h2 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold md:text-5xl">
                Diagnostic{" "}
                <span className="text-[color:var(--color-brand-cyan)]">
                  Packages
                </span>
              </h2>
              <p className="mt-3 max-w-xl text-sm text-white/70">
                Most requested package groups. Open the services page for full
                inclusions and exact prices.
              </p>
            </div>
            <Link
              href="/contact"
              className="rounded-md border-2 border-white px-5 py-2.5 text-sm font-bold text-white transition-colors hover:bg-white hover:text-[color:var(--color-brand-navy)]"
            >
              Custom Corporate Package →
            </Link>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {PACKAGE_GROUPS.map((pkg) => (
              <article
                key={pkg.title}
                className="rounded-xl border border-white/10 bg-white/5 p-6 backdrop-blur"
              >
                <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
                  {pkg.type}
                </p>
                <h3 className="mt-3 font-[family-name:var(--font-heading)] text-lg font-bold leading-tight">
                  {pkg.title}
                </h3>
                <p className="mt-2 text-sm text-white/70">{pkg.desc}</p>
                <p className="mt-4 text-sm font-bold text-[color:var(--color-brand-cyan)]">
                  {pkg.range}
                </p>
                <ul className="mt-4 space-y-1.5 border-t border-white/10 pt-4 text-xs text-white/70">
                  {pkg.items.map((item) => (
                    <li key={item}>· {item}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* CTA ------------------------------------------------------------ */}
      <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
        <div className="rounded-3xl bg-gradient-to-br from-[color:var(--color-brand-cyan)] to-[color:var(--color-brand-navy)] p-10 text-white md:p-16">
          <h2 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold md:text-4xl">
            Lab results, securely accessible.
          </h2>
          <p className="mt-3 max-w-2xl text-sm text-white/80 md:text-base">
            Sign in to the Patient Portal with your DRM-ID and the Secure PIN
            printed on your receipt.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/portal/login"
              className="rounded-md bg-white px-6 py-3 text-sm font-bold text-[color:var(--color-brand-navy)] shadow-md transition-colors hover:bg-[color:var(--color-brand-bg)]"
            >
              Access My Results
            </Link>
            <Link
              href="/contact"
              className="rounded-md border-2 border-white px-6 py-3 text-sm font-bold text-white transition-colors hover:bg-white hover:text-[color:var(--color-brand-navy)]"
            >
              Inquire / Book
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
