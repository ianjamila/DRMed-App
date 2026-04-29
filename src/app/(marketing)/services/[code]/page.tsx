import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { formatPhp, getServiceByCode } from "@/lib/marketing/services";

interface ServicePageProps {
  params: Promise<{ code: string }>;
}

export async function generateMetadata({
  params,
}: ServicePageProps): Promise<Metadata> {
  const { code } = await params;
  const service = await getServiceByCode(code);
  if (!service) return { title: "Service" };
  return {
    title: service.name,
    description:
      service.description ??
      `${service.name} — laboratory test at DRMed Clinic & Laboratory.`,
  };
}

export default async function ServiceDetailPage({ params }: ServicePageProps) {
  const { code } = await params;
  const service = await getServiceByCode(code);
  if (!service) notFound();

  return (
    <article className="mx-auto max-w-4xl px-4 py-12 sm:px-6 lg:px-8">
      <Link
        href="/services"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← All services
      </Link>

      <header className="mt-6">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          {service.code}
        </p>
        <h1 className="mt-2 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)] md:text-4xl">
          {service.name}
        </h1>
      </header>

      <dl className="mt-8 grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5">
          <dt className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
            Price
          </dt>
          <dd className="mt-2 font-[family-name:var(--font-heading)] text-2xl font-extrabold text-[color:var(--color-brand-navy)]">
            {formatPhp(service.price_php)}
          </dd>
        </div>
        <div className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5">
          <dt className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
            Turnaround
          </dt>
          <dd className="mt-2 font-[family-name:var(--font-heading)] text-2xl font-extrabold text-[color:var(--color-brand-navy)]">
            {service.turnaround_hours
              ? `${service.turnaround_hours} hours`
              : "Inquire"}
          </dd>
        </div>
        <div className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5">
          <dt className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
            Code
          </dt>
          <dd className="mt-2 font-[family-name:var(--font-heading)] text-2xl font-extrabold text-[color:var(--color-brand-navy)]">
            {service.code}
          </dd>
        </div>
      </dl>

      {service.description ? (
        <section className="mt-10">
          <h2 className="font-[family-name:var(--font-heading)] text-xl font-extrabold text-[color:var(--color-brand-navy)]">
            About this test
          </h2>
          <p className="mt-3 text-base leading-relaxed text-[color:var(--color-brand-text-mid)]">
            {service.description}
          </p>
        </section>
      ) : null}

      <section className="mt-10 rounded-2xl bg-gradient-to-br from-[color:var(--color-brand-cyan)] to-[color:var(--color-brand-navy)] p-8 text-white">
        <h2 className="font-[family-name:var(--font-heading)] text-xl font-extrabold">
          Ready to book?
        </h2>
        <p className="mt-2 text-sm text-white/80">
          Walk in during operating hours, or send us a message and we&apos;ll
          help you schedule.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link
            href="/schedule"
            className="rounded-md bg-white px-5 py-2.5 text-sm font-bold text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]"
          >
            View Schedule
          </Link>
          <Link
            href="/contact"
            className="rounded-md border-2 border-white px-5 py-2.5 text-sm font-bold text-white hover:bg-white hover:text-[color:var(--color-brand-navy)]"
          >
            Send Message
          </Link>
        </div>
      </section>

      <p className="mt-8 text-xs text-[color:var(--color-brand-text-soft)]">
        Prices may change without prior notice. Final pricing is confirmed at
        the clinic upon registration.
      </p>
    </article>
  );
}
