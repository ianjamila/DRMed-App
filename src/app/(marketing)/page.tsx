import Image from "next/image";
import Link from "next/link";
import {
  CONTACT,
  HERO_STATS,
  PACKAGE_GROUPS,
  SERVICE_HIGHLIGHTS,
  SITE,
  SOCIAL,
  TRUST_BAR,
} from "@/lib/marketing/site";
import { PHYSICIANS } from "@/lib/marketing/physicians";
import { HmoTicker } from "@/components/marketing/hmo-ticker";
import { ContactForm } from "./contact/contact-form";

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
  sameAs: [SOCIAL.facebook, SOCIAL.instagram],
};

const SPECIALTY_GROUPS = [
  {
    title: "OB-GYN",
    count: 2,
    members: ["Dr. Maria Cecilia Castelo-Brojas", "Dr. Nadia Mariano"],
  },
  {
    title: "Family Medicine",
    count: 3,
    members: [
      "Dr. Julie Ann Pacis-Caling",
      "Dr. Armelle Keisha Mendoza",
      "Dr. Jaemari Elleazar",
    ],
  },
  {
    title: "Pediatrics",
    count: 3,
    members: [
      "Dr. Katherine Gayo",
      "Dr. Dominique Antonio",
      "Dr. Aurora Vicencio",
    ],
  },
  {
    title: "Internal Medicine",
    count: 6,
    members: [
      "Dr. Robert Vicencio",
      "Dr. Archangel Manuel",
      "Dr. Ferdinand Dantes",
      "Dr. Angelle Dantes · Dr. Lei Baldeviso · Dr. Gideon Libiran",
    ],
  },
  {
    title: "ENT",
    count: 2,
    members: ["Dr. Angelica Lorenzo", "Dr. Claudette Anglo"],
  },
  {
    title: "Other Specialties",
    count: 3,
    members: [
      "Dr. Alain Arcega (Ophthalmology)",
      "Dr. Daniel John Mariano (Radiology)",
      "Dr. Mary Rose Alvarez (Surgery)",
    ],
  },
];

const PORTAL_FEATURES = [
  {
    icon: "🔑",
    title: "Secure PIN Access",
    desc: "Sign in using the claim password printed on your official laboratory receipt.",
  },
  {
    icon: "📄",
    title: "PDF Download",
    desc: "Download official signed lab results, ready to share with your physician.",
  },
  {
    icon: "📜",
    title: "Full History Access",
    desc: "View all past results. Track your health trends over time.",
  },
  {
    icon: "🛡️",
    title: "RA 10173 Compliant",
    desc: "All records handled in accordance with the Philippine Data Privacy Act.",
  },
];

const PAYMENT_METHODS = [
  { icon: "💵", title: "Cash", desc: "Pay over the counter at the clinic." },
  {
    icon: "📱",
    title: "QR Payments",
    desc: "GCash / PayMaya or other QR-supported wallets.",
  },
  {
    icon: "🏦",
    title: "Bank Transfer",
    desc: "Local bank transfer or online banking.",
  },
  {
    icon: "💳",
    title: "Card Payments",
    desc: "Debit and credit card accepted.",
  },
];

const mapsHref = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
  CONTACT.address.full,
)}`;

export default function HomePage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      {/* ── 1. Hero ───────────────────────────────────────────────────────── */}
      <section
        id="home"
        className="relative overflow-hidden bg-gradient-to-b from-[color:var(--color-brand-bg)] to-white"
      >
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
                href="/#packages"
                className="rounded-md bg-[color:var(--color-brand-navy)] px-6 py-3 text-sm font-bold text-white shadow-md transition-colors hover:bg-[color:var(--color-brand-cyan)]"
              >
                View Packages
              </Link>
              <Link
                href="/physicians"
                className="rounded-md border-2 border-[color:var(--color-brand-navy)] bg-white px-6 py-3 text-sm font-bold text-[color:var(--color-brand-navy)] transition-colors hover:bg-[color:var(--color-brand-navy)] hover:text-white"
              >
                Meet Our Doctors
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
            <div className="relative">
              <Image
                src="/hero-clinic.jpg"
                alt="DRMed Clinic"
                width={720}
                height={900}
                priority
                className="h-[520px] w-full rounded-2xl object-cover shadow-xl"
              />
              <div className="absolute -bottom-6 -left-6 rounded-2xl bg-[color:var(--color-brand-navy)] p-5 text-white shadow-xl">
                <p className="text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
                  Accredited Facility
                </p>
                <p className="mt-1 font-[family-name:var(--font-heading)] text-lg font-extrabold">
                  10 HMO Partners
                </p>
                <p className="text-xs text-white/70">Cashless · No hassle</p>
              </div>
              <div className="absolute -top-6 -right-6 rounded-2xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5 shadow-xl">
                <p className="text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
                  Average Turnaround
                </p>
                <p className="mt-1 font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
                  24 Hours
                </p>
                <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                  Most tests same-day
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── 2. Trust bar ──────────────────────────────────────────────────── */}
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

      {/* ── 3. Services ───────────────────────────────────────────────────── */}
      <section
        id="services"
        className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8"
      >
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
            href="/#packages"
            className="rounded-md bg-[color:var(--color-brand-navy)] px-5 py-2.5 text-sm font-bold text-white transition-colors hover:bg-[color:var(--color-brand-cyan)]"
          >
            View All Packages →
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

      {/* ── 4. Packages summary ───────────────────────────────────────────── */}
      <section id="packages" className="bg-[color:var(--color-brand-navy)] text-white">
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
                Quick overview of our most requested package groups. For full
                inclusions, exact test lists, and complete price details, open
                the detailed packages page.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link
                href="/packages"
                className="rounded-md bg-white px-5 py-2.5 text-sm font-bold text-[color:var(--color-brand-navy)] transition-colors hover:bg-[color:var(--color-brand-bg)]"
              >
                View Detailed Packages →
              </Link>
              <Link
                href="/#contact"
                className="rounded-md border-2 border-white px-5 py-2.5 text-sm font-bold text-white transition-colors hover:bg-white hover:text-[color:var(--color-brand-navy)]"
              >
                Custom Corporate Package →
              </Link>
            </div>
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

          <p className="mt-8 text-center text-xs text-white/50">
            Detailed package inclusions and prices are available on the
            dedicated page. Prices may change without prior notice.
          </p>
        </div>
      </section>

      {/* ── 5. Specialists strip ─────────────────────────────────────────── */}
      <section
        id="doctors"
        className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8"
      >
        <div className="mb-10">
          <p className="mb-2 inline-flex items-center gap-3 text-xs font-bold uppercase tracking-[0.18em] text-[color:var(--color-brand-cyan)]">
            <span className="h-px w-8 bg-[color:var(--color-brand-cyan)]" />
            Our Specialists
          </p>
          <h2 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)] md:text-5xl">
            Meet Our{" "}
            <span className="text-[color:var(--color-brand-cyan)]">Doctors</span>
          </h2>
          <p className="mt-3 max-w-2xl text-sm text-[color:var(--color-brand-text-mid)]">
            DRMed has {PHYSICIANS.length}+ board-certified physicians across key
            specialties. For complete schedules and doctor photos, open the
            detailed schedules page.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {SPECIALTY_GROUPS.map((group) => (
            <article
              key={group.title}
              className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6"
            >
              <div className="flex items-baseline justify-between">
                <h3 className="font-[family-name:var(--font-heading)] text-lg font-bold text-[color:var(--color-brand-navy)]">
                  {group.title}
                </h3>
                <span className="text-xs font-medium text-[color:var(--color-brand-cyan)]">
                  {group.count} physicians
                </span>
              </div>
              <ul className="mt-4 space-y-1.5 border-t border-[color:var(--color-brand-bg-mid)] pt-4 text-sm text-[color:var(--color-brand-text-mid)]">
                {group.members.map((m) => (
                  <li key={m}>· {m}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>

        <div className="mt-8 flex flex-col items-start gap-3 rounded-xl bg-[color:var(--color-brand-bg)] p-5 text-sm sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[color:var(--color-brand-text-mid)]">
            ⚠️ Schedules may change without prior notice. Kindly call or message
            us to book your appointment and confirm availability.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/physicians"
              className="rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-xs font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
            >
              View Detailed Schedules →
            </Link>
            <Link
              href="/#contact"
              className="rounded-md border border-[color:var(--color-brand-navy)] px-4 py-2 text-xs font-bold text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-navy)] hover:text-white"
            >
              Book an Appointment
            </Link>
          </div>
        </div>
      </section>

      {/* ── 6. Patient portal teaser ─────────────────────────────────────── */}
      <section className="bg-gradient-to-br from-[color:var(--color-brand-bg)] to-white">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
          <div className="mb-10 max-w-3xl">
            <p className="mb-2 inline-flex items-center gap-3 text-xs font-bold uppercase tracking-[0.18em] text-[color:var(--color-brand-cyan)]">
              <span className="h-px w-8 bg-[color:var(--color-brand-cyan)]" />
              Patient Portal
            </p>
            <h2 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)] md:text-5xl">
              Your Results,{" "}
              <span className="text-[color:var(--color-brand-cyan)]">
                Securely Accessible
              </span>
            </h2>
            <p className="mt-4 text-base text-[color:var(--color-brand-text-mid)]">
              No more waiting in queues. Access your complete lab results
              online, anytime — secured with your receipt-issued claim password
              and Philippine Data Privacy Act compliance.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {PORTAL_FEATURES.map((feat) => (
              <article
                key={feat.title}
                className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6"
              >
                <span className="text-2xl" aria-hidden>
                  {feat.icon}
                </span>
                <h3 className="mt-4 font-[family-name:var(--font-heading)] text-lg font-bold text-[color:var(--color-brand-navy)]">
                  {feat.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-[color:var(--color-brand-text-soft)]">
                  {feat.desc}
                </p>
              </article>
            ))}
          </div>

          <div className="mt-10 rounded-2xl bg-[color:var(--color-brand-navy)] p-8 text-white md:p-12">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
                  Secure Patient Sign-In
                </p>
                <h3 className="mt-2 font-[family-name:var(--font-heading)] text-2xl font-extrabold">
                  Access My Results
                </h3>
                <p className="mt-1 text-sm text-white/70">
                  Use your DRM-ID and the Secure PIN printed on your receipt.
                </p>
              </div>
              <Link
                href="/portal/login"
                className="rounded-md bg-[color:var(--color-brand-cyan)] px-6 py-3 text-sm font-bold text-white shadow-md hover:bg-white hover:text-[color:var(--color-brand-navy)]"
              >
                Open Patient Portal →
              </Link>
            </div>
            <p className="mt-6 text-xs text-white/50">
              🔒 Protected under the Philippine Data Privacy Act (RA 10173).
            </p>
          </div>
        </div>
      </section>

      {/* ── 7. HMO ticker ─────────────────────────────────────────────────── */}
      <section id="hmo" className="bg-[color:var(--color-brand-bg)] py-20">
        <div className="mx-auto mb-10 max-w-7xl px-4 text-center sm:px-6 lg:px-8">
          <p className="mb-2 inline-flex items-center gap-3 text-xs font-bold uppercase tracking-[0.18em] text-[color:var(--color-brand-cyan)]">
            <span className="h-px w-8 bg-[color:var(--color-brand-cyan)]" />
            Accredited HMO Partners
            <span className="h-px w-8 bg-[color:var(--color-brand-cyan)]" />
          </p>
          <h2 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)] md:text-5xl">
            We Accept Your{" "}
            <span className="text-[color:var(--color-brand-cyan)]">HMO</span>
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-sm text-[color:var(--color-brand-text-mid)]">
            Present your HMO card at the clinic. Cashless transactions
            available for all covered services.
          </p>
        </div>
        <HmoTicker />
      </section>

      {/* ── 8. Payment options ────────────────────────────────────────────── */}
      <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
        <div className="mb-10 max-w-3xl">
          <p className="mb-2 inline-flex items-center gap-3 text-xs font-bold uppercase tracking-[0.18em] text-[color:var(--color-brand-cyan)]">
            <span className="h-px w-8 bg-[color:var(--color-brand-cyan)]" />
            Payment Options
          </p>
          <h2 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)] md:text-5xl">
            100%{" "}
            <span className="text-[color:var(--color-brand-cyan)]">
              Convenient
            </span>{" "}
            Payments
          </h2>
          <p className="mt-3 text-sm text-[color:var(--color-brand-text-mid)]">
            LESS RISK & MORE CONVENIENT: No more long waiting times inside
            crowded hospitals or health centers. Accessible, hassle-free,
            effortless payment options are available for your visit.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {PAYMENT_METHODS.map((method) => (
            <article
              key={method.title}
              className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6"
            >
              <span className="text-3xl" aria-hidden>
                {method.icon}
              </span>
              <h3 className="mt-4 font-[family-name:var(--font-heading)] text-lg font-bold text-[color:var(--color-brand-navy)]">
                {method.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-[color:var(--color-brand-text-soft)]">
                {method.desc}
              </p>
            </article>
          ))}
        </div>

        <p className="mt-6 text-sm text-[color:var(--color-brand-text-soft)]">
          Need assistance? Our front desk will guide you through the payment
          method that works best for you.
        </p>
      </section>

      {/* ── 9. Contact ────────────────────────────────────────────────────── */}
      <section
        id="contact"
        className="bg-[color:var(--color-brand-navy)] text-white"
      >
        <div className="mx-auto grid max-w-7xl gap-12 px-4 py-20 sm:px-6 md:grid-cols-2 lg:px-8">
          <div>
            <p className="mb-2 inline-flex items-center gap-3 text-xs font-bold uppercase tracking-[0.18em] text-[color:var(--color-brand-cyan)]">
              <span className="h-px w-8 bg-[color:var(--color-brand-cyan)]" />
              Reach Us
            </p>
            <h2 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold md:text-5xl">
              Get in{" "}
              <span className="text-[color:var(--color-brand-cyan)]">
                Touch
              </span>
            </h2>
            <p className="mt-3 max-w-md text-sm text-white/70">
              We&apos;re here to help with appointments, inquiries, and
              corporate packages.
            </p>

            <dl className="mt-10 space-y-6 text-sm">
              <div>
                <dt className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
                  Address
                </dt>
                <dd className="mt-1 text-white/80">
                  4F Northridge Plaza
                  <br />
                  Quezon City, Philippines
                </dd>
                <dd className="mt-2 text-xs text-white/60">
                  Pin: Northridge Plaza, Congressional Avenue, Quezon City{" "}
                  <a
                    href={mapsHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[color:var(--color-brand-cyan)] hover:underline"
                  >
                    Open in Maps ↗
                  </a>
                </dd>
              </div>
              <div>
                <dt className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
                  Clinic Hours
                </dt>
                <dd className="mt-1 text-white/80">
                  Monday – Saturday
                  <br />
                  8:00 AM – 5:00 PM
                </dd>
              </div>
              <div>
                <dt className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
                  Phone
                </dt>
                <dd className="mt-1">
                  <a
                    href={`tel:${CONTACT.phone.mobileE164}`}
                    className="text-white/80 hover:text-white"
                  >
                    {CONTACT.phone.mobile}
                  </a>
                  <span className="text-white/40"> · </span>
                  <a
                    href={`tel:${CONTACT.phone.landlineE164}`}
                    className="text-white/80 hover:text-white"
                  >
                    {CONTACT.phone.landline}
                  </a>
                </dd>
              </div>
              <div>
                <dt className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
                  Connect With Us
                </dt>
                <dd className="mt-2 flex flex-wrap gap-3 text-xs">
                  <a
                    href={SOCIAL.facebook}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-md border border-white/20 px-3 py-1.5 text-white/80 hover:bg-white/10 hover:text-white"
                  >
                    📘 Facebook
                  </a>
                  <a
                    href={SOCIAL.instagram}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-md border border-white/20 px-3 py-1.5 text-white/80 hover:bg-white/10 hover:text-white"
                  >
                    📷 Instagram
                  </a>
                </dd>
              </div>
            </dl>
          </div>

          <div className="rounded-2xl border border-white/10 bg-white p-8 text-[color:var(--color-brand-text)]">
            <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
              Inquire / Book
            </p>
            <h3 className="mt-2 font-[family-name:var(--font-heading)] text-xl font-extrabold text-[color:var(--color-brand-navy)]">
              Send us a Message
            </h3>
            <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
              For appointments, corporate packages, or general inquiries.
            </p>
            <div className="mt-6">
              <ContactForm />
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
