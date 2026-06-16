import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ArrowLeft, ArrowRight, Check, Clock, Tag } from "lucide-react";
import { getServiceByCode } from "@/lib/marketing/services";
import { formatPhp } from "@/lib/marketing/format";
import { PageHero } from "@/components/marketing/page-hero";
import { PillLink } from "@/components/marketing/ui";
import { Reveal } from "@/components/marketing/motion";
import { SITE } from "@/lib/marketing/site";
import { pageMetadata } from "@/lib/marketing/metadata";
import { serviceOfferLd, breadcrumbLd } from "@/lib/marketing/structured-data";
import { JsonLd } from "@/components/marketing/json-ld";

interface ServicePageProps {
  params: Promise<{ code: string }>;
}

// Splits package descriptions like "CBC, Urinalysis; Chest X-Ray (PA)." into
// trimmed, deduped items so they render as a clean bullet list.
function splitIncludes(desc: string): string[] {
  return desc
    .split(/[;,]+|\s+and\s+/i)
    .map((s) => s.replace(/[.\s]+$/g, "").trim())
    .filter((s) => s.length > 0);
}

export async function generateMetadata({
  params,
}: ServicePageProps): Promise<Metadata> {
  const { code } = await params;
  const service = await getServiceByCode(code);
  if (!service) return { title: "Service" };
  return pageMetadata({
    title: service.name,
    description:
      service.description ??
      `${service.name} — laboratory test at ${SITE.name}.`,
    path: `/all-services/${service.code.toLowerCase()}`,
  });
}

export default async function ServiceDetailPage({ params }: ServicePageProps) {
  const { code } = await params;
  const service = await getServiceByCode(code);
  if (!service) notFound();

  const ld = [
    serviceOfferLd({
      code: service.code,
      name: service.name,
      description: service.description,
      kind: service.kind,
      pricePhp: service.price_php,
    }),
    breadcrumbLd([
      { name: "Home", path: "/" },
      { name: "All Services", path: "/all-services" },
      { name: service.name, path: `/all-services/${service.code.toLowerCase()}` },
    ]),
  ];

  return (
    <>
      <JsonLd data={ld} />
      <PageHero
        eyebrow={service.code}
        title={service.name}
      />

      <article className="py-16 sm:py-20">
        <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">

          {/* Back link */}
          <Link
            href="/all-services"
            className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan-text)] transition-colors hover:text-[color:var(--color-brand-navy)]"
          >
            <ArrowLeft aria-hidden className="h-3.5 w-3.5" />
            All services
          </Link>

          {/* Stats cards */}
          <Reveal>
            <dl className="mt-8 grid gap-4 sm:grid-cols-3">
              {/* Price */}
              <div className="rounded-[20px] border border-[color:var(--color-warm-line-soft)] bg-white p-5 shadow-[var(--shadow-warm-sm)]">
                <dt className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan-text)]">
                  Price
                </dt>
                <dd className="mt-2">
                  {service.kind === "lab_package" ? (
                    <span className="font-[family-name:var(--font-display)] text-2xl italic text-[color:var(--color-brand-cyan-text)]">
                      {formatPhp(service.price_php)}
                    </span>
                  ) : (
                    <span className="text-base font-semibold text-[color:var(--color-ink-mid)]">
                      Confirmed at reception
                    </span>
                  )}
                </dd>
              </div>

              {/* Turnaround */}
              <div className="rounded-[20px] border border-[color:var(--color-warm-line-soft)] bg-white p-5 shadow-[var(--shadow-warm-sm)]">
                <dt className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan-text)]">
                  <Clock aria-hidden className="h-3.5 w-3.5" />
                  Turnaround
                </dt>
                <dd className="mt-2 font-[family-name:var(--font-display)] text-2xl text-[color:var(--color-brand-navy)]">
                  {service.turnaround_hours
                    ? `${service.turnaround_hours} hours`
                    : "Inquire"}
                </dd>
              </div>

              {/* Code */}
              <div className="rounded-[20px] border border-[color:var(--color-warm-line-soft)] bg-white p-5 shadow-[var(--shadow-warm-sm)]">
                <dt className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan-text)]">
                  <Tag aria-hidden className="h-3.5 w-3.5" />
                  Code
                </dt>
                <dd className="mt-2 font-[family-name:var(--font-display)] text-2xl text-[color:var(--color-brand-navy)]">
                  {service.code}
                </dd>
              </div>
            </dl>
          </Reveal>

          {/* Fasting / time-slot notices */}
          {(service.fasting_required || service.requires_time_slot) && (
            <Reveal delay={0.08}>
              <div className="mt-6 flex flex-wrap gap-2">
                {service.fasting_required && (
                  <span className="rounded-full bg-amber-100 px-3 py-1 text-sm font-semibold text-amber-900">
                    Fasting required
                  </span>
                )}
                {service.requires_time_slot && (
                  <span className="rounded-full bg-sky-100 px-3 py-1 text-sm font-semibold text-sky-900">
                    By appointment
                  </span>
                )}
              </div>
            </Reveal>
          )}

          {/* Description / inclusions */}
          {service.description ? (
            service.kind === "lab_package" ? (
              <Reveal delay={0.1}>
                <section className="mt-12">
                  <h2 className="font-[family-name:var(--font-display)] text-2xl text-[color:var(--color-brand-navy)]">
                    What&apos;s included
                  </h2>
                  <ul className="mt-5 grid gap-3 sm:grid-cols-2">
                    {splitIncludes(service.description).map((item) => (
                      <li
                        key={item}
                        className="flex items-start gap-3 rounded-[16px] border border-[color:var(--color-warm-line-soft)] bg-white p-4 text-sm text-[color:var(--color-ink-mid)] shadow-[var(--shadow-warm-sm)]"
                      >
                        <span
                          aria-hidden
                          className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[rgba(8,168,226,0.10)]"
                        >
                          <Check className="h-3 w-3 text-[color:var(--color-brand-cyan-text)]" />
                        </span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              </Reveal>
            ) : (
              <Reveal delay={0.1}>
                <section className="mt-12">
                  <h2 className="font-[family-name:var(--font-display)] text-2xl text-[color:var(--color-brand-navy)]">
                    About this test
                  </h2>
                  <p className="mt-4 text-base leading-relaxed text-[color:var(--color-ink-mid)]">
                    {service.description}
                  </p>
                </section>
              </Reveal>
            )
          ) : null}

          {/* CTA band */}
          <Reveal delay={0.15}>
            <section className="mt-12 rounded-[20px] border border-[color:var(--color-brand-navy)] bg-[color:var(--color-brand-navy)] p-8 text-white shadow-[var(--shadow-warm-lg)]">
              <h2 className="font-[family-name:var(--font-display)] text-2xl font-normal">
                Ready to book?
              </h2>
              <p className="mt-2 text-sm text-white/75">
                Walk in during operating hours, or send us a message and
                we&apos;ll help you schedule.
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <PillLink href="/schedule" variant="cyan" size="md">
                  View Schedule
                  <ArrowRight aria-hidden className="h-4 w-4" />
                </PillLink>
                <PillLink href="/contact" variant="lineOnDark" size="md">
                  Send Message
                </PillLink>
              </div>
            </section>
          </Reveal>

          {/* Disclaimer */}
          <Reveal delay={0.18}>
            <p className="mt-8 text-xs text-[color:var(--color-ink-soft)]">
              Prices may change without prior notice. Final pricing is confirmed
              at the clinic upon registration.
            </p>
          </Reveal>

        </div>
      </article>
    </>
  );
}
