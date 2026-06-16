import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import { Calendar, MapPin, Clock, Phone, ExternalLink } from "lucide-react";
import { createClient as createAnonClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { SITE, CONTACT, GEO } from "@/lib/marketing/site";
import { pageMetadata } from "@/lib/marketing/metadata";
import { physicianLd, breadcrumbLd } from "@/lib/marketing/structured-data";
import { JsonLd } from "@/components/marketing/json-ld";
import { physicianPhotoUrl } from "@/lib/physicians/photo";
import { formatSchedule } from "@/lib/physicians/format-schedule";
import { Reveal } from "@/components/marketing/motion";
import { PillLink } from "@/components/marketing/ui";

export const revalidate = 300;

// Stateless ANON client for this public page's reads. No cookies() → the route
// is statically generated + ISR-cached (see `revalidate`) instead of rendered
// dynamically per request. Respects RLS (physicians + physician_schedules are
// public-readable) and never touches the service-role key.
function publicClient() {
  return createAnonClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  );
}

export async function generateStaticParams() {
  // Build-time: enumerate active physician slugs so each page is prebuilt as
  // static HTML. Guard: without DB env (e.g. bare CI builds) return [] so
  // Next.js falls back to on-demand ISR rendering.
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return [];
  }
  const { data } = await publicClient()
    .from("physicians")
    .select("slug")
    .eq("is_active", true)
    .order("display_order", { ascending: true })
    .order("full_name", { ascending: true });
  return (data ?? []).map((d) => ({ slug: d.slug }));
}

interface PageProps {
  params: Promise<{ slug: string }>;
}

interface PhysicianRow {
  id: string;
  slug: string;
  full_name: string;
  specialty: string;
  group_label: string | null;
  bio: string | null;
  photo_path: string | null;
}

async function loadPhysician(slug: string): Promise<PhysicianRow | null> {
  const { data, error } = await publicClient()
    .from("physicians")
    .select("id, slug, full_name, specialty, group_label, bio, photo_path")
    .eq("slug", slug)
    .eq("is_active", true)
    .maybeSingle();
  if (error || !data) return null;
  return data as PhysicianRow;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const doc = await loadPhysician(slug);
  if (!doc) return { title: "Physician" };
  const description =
    doc.bio?.slice(0, 155) ??
    `${doc.full_name}, ${doc.specialty} at ${SITE.name} in Quezon City. View clinic schedule and book a consultation.`;
  return pageMetadata({
    title: `${doc.full_name} — ${doc.specialty}`,
    description,
    path: `/physicians/${doc.slug}`,
    image: physicianPhotoUrl({ slug: doc.slug, photo_path: doc.photo_path }),
  });
}

export default async function PhysicianPage({ params }: PageProps) {
  const { slug } = await params;
  const doc = await loadPhysician(slug);
  if (!doc) notFound();

  const { data: scheduleRows } = await publicClient()
    .from("physician_schedules")
    .select("day_of_week, start_time, end_time")
    .eq("physician_id", doc.id);

  const blocks = (scheduleRows ?? []).map((r) => ({
    day_of_week: r.day_of_week,
    start_time: r.start_time,
    end_time: r.end_time,
  }));
  const scheduleLines = formatSchedule(blocks);
  // formatSchedule returns ["By appointment"] for empty blocks; we want
  // an empty array so we can show our own fallback sentence.
  const hasSchedule = blocks.length > 0;

  const photoUrl = physicianPhotoUrl({ slug: doc.slug, photo_path: doc.photo_path });

  const ld = [
    physicianLd({
      slug: doc.slug,
      fullName: doc.full_name,
      specialty: doc.specialty,
      photoUrl,
    }),
    breadcrumbLd([
      { name: "Home", path: "/" },
      { name: "Physicians", path: "/physicians" },
      { name: doc.full_name, path: `/physicians/${doc.slug}` },
    ]),
  ];

  return (
    <>
      <JsonLd data={ld} />

      {/* ── Visual breadcrumb ─────────────────────────────────────────── */}
      <div className="border-b border-[color:var(--color-warm-line-soft)] bg-[color:var(--color-warm-bg)]">
        <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6 lg:px-8">
          <nav aria-label="Breadcrumb">
            <ol className="flex flex-wrap items-center gap-1.5 text-xs text-[color:var(--color-ink-soft)]">
              <li>
                <Link
                  href="/"
                  className="hover:text-[color:var(--color-brand-navy)] transition-colors"
                >
                  Home
                </Link>
              </li>
              <li aria-hidden="true" className="select-none">›</li>
              <li>
                <Link
                  href="/physicians"
                  className="hover:text-[color:var(--color-brand-navy)] transition-colors"
                >
                  Physicians
                </Link>
              </li>
              <li aria-hidden="true" className="select-none">›</li>
              <li className="font-medium text-[color:var(--color-brand-navy)]" aria-current="page">
                {doc.full_name}
              </li>
            </ol>
          </nav>
        </div>
      </div>

      {/* ── Page body ─────────────────────────────────────────────────── */}
      <div className="mx-auto max-w-4xl px-4 py-12 sm:px-6 sm:py-16 lg:px-8">
        <div className="space-y-6">

          {/* ── Hero card ─────────────────────────────────────────────── */}
          <Reveal>
            <article className="overflow-hidden rounded-[24px] border border-[color:var(--color-warm-line-soft)] bg-white shadow-[var(--shadow-warm-sm)]">
              {/* Mobile: photo on top, text below. Desktop: side-by-side. */}
              <div className="flex flex-col sm:flex-row">

                {/* 3/4-aspect portrait */}
                <div className="relative w-full shrink-0 sm:w-56 md:w-64 lg:w-72">
                  {/* aspect-[3/4] on mobile stacks naturally; fixed height on sm+ */}
                  <div className="relative aspect-[3/4] w-full overflow-hidden sm:aspect-auto sm:h-full">
                    <HeroPhoto photoUrl={photoUrl} name={doc.full_name} />
                  </div>
                </div>

                {/* Right side: text content */}
                <div className="flex flex-1 flex-col justify-between gap-6 p-6 sm:p-8">
                  <div className="space-y-4">
                    {/* Specialty eyebrow */}
                    <p className="text-xs font-bold uppercase tracking-[0.12em] text-[color:var(--color-brand-cyan-text)]">
                      {doc.specialty}
                    </p>

                    {/* Doctor name — display font */}
                    <h1 className="font-[family-name:var(--font-display)] text-[clamp(26px,4vw,40px)] font-normal leading-[1.08] tracking-[-0.01em] text-[color:var(--color-brand-navy)]">
                      {doc.full_name}
                    </h1>

                    {/* Group label chip (e.g. "Pediatric Specialists") */}
                    {doc.group_label && (
                      <span className="inline-flex h-6 items-center rounded-full bg-[rgba(8,168,226,0.10)] px-3 text-xs font-bold text-[color:var(--color-brand-cyan-text)]">
                        {doc.group_label}
                      </span>
                    )}

                    {/* Bio — only when present */}
                    {doc.bio && (
                      <p className="text-[14.5px] leading-relaxed text-[color:var(--color-ink-mid)]">
                        {doc.bio}
                      </p>
                    )}
                  </div>

                  {/* Book CTA */}
                  <div>
                    <PillLink
                      href={`/schedule?doctor=${doc.slug}`}
                      variant="navy"
                      size="md"
                    >
                      Book an appointment →
                    </PillLink>
                  </div>
                </div>
              </div>
            </article>
          </Reveal>

          {/* ── Schedule card ─────────────────────────────────────────── */}
          <Reveal delay={0.07}>
            <div className="rounded-[20px] border border-[color:var(--color-warm-line-soft)] bg-white p-6 shadow-[var(--shadow-warm-sm)] sm:p-8">
              <h2 className="mb-4 font-[family-name:var(--font-display)] text-xl font-normal text-[color:var(--color-brand-navy)]">
                Clinic Schedule
              </h2>
              {hasSchedule ? (
                <ul className="space-y-2">
                  {scheduleLines.map((line) => (
                    <li
                      key={line}
                      className="flex items-center gap-2.5 text-[14.5px] text-[color:var(--color-ink-mid)]"
                    >
                      <Calendar
                        className="h-4 w-4 shrink-0 text-[color:var(--color-brand-cyan)]"
                        aria-hidden="true"
                      />
                      {line}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="flex items-center gap-2.5 text-[14.5px] text-[color:var(--color-ink-mid)]">
                  <Calendar
                    className="h-4 w-4 shrink-0 text-[color:var(--color-brand-cyan)]"
                    aria-hidden="true"
                  />
                  By appointment — reception confirms the slot.
                </p>
              )}
              <p className="mt-4 text-xs text-[color:var(--color-ink-soft)]">
                Schedules may change without notice. Call{" "}
                <a
                  href={`tel:${CONTACT.phone.mobileE164}`}
                  className="font-bold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan-text)]"
                >
                  {CONTACT.phone.mobile}
                </a>{" "}
                to confirm availability.
              </p>
            </div>
          </Reveal>

          {/* ── Location card (reused from contact page pattern) ──────── */}
          <Reveal delay={0.12}>
            <div className="rounded-[20px] border border-[color:var(--color-warm-line-soft)] bg-white p-6 shadow-[var(--shadow-warm-sm)] sm:p-8">
              <h2 className="mb-5 font-[family-name:var(--font-display)] text-xl font-normal text-[color:var(--color-brand-navy)]">
                Visit Us
              </h2>
              <div className="space-y-4">
                {/* Address */}
                <div className="flex items-start gap-3">
                  <span
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[rgba(8,168,226,0.10)] text-[color:var(--color-brand-cyan)]"
                    aria-hidden="true"
                  >
                    <MapPin className="h-4 w-4" />
                  </span>
                  <div>
                    <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[color:var(--color-brand-cyan-text)]">
                      Address
                    </p>
                    <p className="mt-1 text-[14px] leading-relaxed text-[color:var(--color-ink-mid)]">
                      {CONTACT.address.line1}
                      <br />
                      {CONTACT.address.line2}, {CONTACT.address.city}
                    </p>
                    <a
                      href={GEO.mapUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 inline-flex items-center gap-1 text-[13px] text-[color:var(--color-brand-cyan-text)] underline-offset-2 hover:underline"
                    >
                      Get directions
                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                  </div>
                </div>

                {/* Hours */}
                <div className="flex items-start gap-3">
                  <span
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[rgba(8,168,226,0.10)] text-[color:var(--color-brand-cyan)]"
                    aria-hidden="true"
                  >
                    <Clock className="h-4 w-4" />
                  </span>
                  <div>
                    <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[color:var(--color-brand-cyan-text)]">
                      Clinic Hours
                    </p>
                    <p className="mt-1 text-[14px] leading-relaxed text-[color:var(--color-ink-mid)]">
                      {CONTACT.hours}
                    </p>
                  </div>
                </div>

                {/* Phone */}
                <div className="flex items-start gap-3">
                  <span
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[rgba(8,168,226,0.10)] text-[color:var(--color-brand-cyan)]"
                    aria-hidden="true"
                  >
                    <Phone className="h-4 w-4" />
                  </span>
                  <div>
                    <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[color:var(--color-brand-cyan-text)]">
                      Phone
                    </p>
                    <p className="mt-1 text-[14px] leading-relaxed">
                      <a
                        href={`tel:${CONTACT.phone.mobileE164}`}
                        className="text-[color:var(--color-ink-mid)] hover:text-[color:var(--color-brand-navy)]"
                      >
                        {CONTACT.phone.mobile}
                      </a>
                      {" · "}
                      <a
                        href={`tel:${CONTACT.phone.landlineE164}`}
                        className="text-[color:var(--color-ink-mid)] hover:text-[color:var(--color-brand-navy)]"
                      >
                        {CONTACT.phone.landline}
                      </a>
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </Reveal>

          {/* ── Back link ─────────────────────────────────────────────── */}
          <Reveal delay={0.15}>
            <div className="flex items-center gap-4">
              <Link
                href="/physicians"
                className="text-sm font-medium text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan-text)] transition-colors"
              >
                ← All specialists
              </Link>
              <span className="text-[color:var(--color-warm-line-soft)]" aria-hidden="true">·</span>
              <PillLink href={`/schedule?doctor=${doc.slug}`} variant="line" size="sm">
                Book appointment
              </PillLink>
            </div>
          </Reveal>
        </div>
      </div>
    </>
  );
}

/**
 * Hero portrait: fills its container, 3/4-aspect on mobile (via parent),
 * full height on sm+. Falls back to initials on image error. This is a Server
 * Component wrapper around DoctorPhoto, but DoctorPhoto is a client component
 * (needs useState for error). We inline a simpler RSC-safe version here to
 * avoid forcing "use client" on this route — the image is in a static src so
 * onError is nice-to-have not critical. For parity with DoctorPhoto we use
 * Next/Image + fill + object-cover.
 *
 * NOTE: If the image 404s the <img> is replaced by the alt text. Production
 * doctor photos are either /public/doctors/<slug>.jpg (static) or Supabase
 * Storage (absolute URL). Both are handled by physicianPhotoUrl.
 */
function HeroPhoto({ photoUrl, name }: { photoUrl: string; name: string }) {
  return (
    <Image
      src={photoUrl}
      alt={name}
      fill
      sizes="(min-width: 1024px) 288px, (min-width: 640px) 224px, 100vw"
      className="object-cover object-top"
      priority
      unoptimized={!photoUrl.startsWith("/")}
    />
  );
}

