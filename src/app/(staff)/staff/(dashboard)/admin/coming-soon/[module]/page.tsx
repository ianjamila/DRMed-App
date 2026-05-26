import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminStaff } from "@/lib/auth/require-admin";

export const dynamic = "force-dynamic";

interface PlannedModule {
  label: string;
  description: string;
  audience: string;
  highlights: string[];
}

const MODULES: Record<string, PlannedModule> = {
};

interface PageProps {
  params: Promise<{ module: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { module: slug } = await params;
  const mod = MODULES[slug];
  return {
    title: mod ? `${mod.label} — coming soon` : "Coming soon",
  };
}

export default async function ComingSoonPage({ params }: PageProps) {
  await requireAdminStaff();
  const { module: slug } = await params;
  const mod = MODULES[slug];

  if (!mod) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/staff"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Dashboard
      </Link>
      <header className="mt-3">
        <span className="inline-flex items-center rounded-full bg-[color:var(--color-brand-cyan)]/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          Planned
        </span>
        <h1 className="mt-3 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          {mod.label}
        </h1>
        <p className="mt-1 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          For {mod.audience}
        </p>
        <p className="mt-3 text-base text-[color:var(--color-brand-text)]">
          {mod.description}
        </p>
      </header>

      <section className="mt-8 rounded-xl border border-dashed border-[color:var(--color-brand-cyan-light)] bg-[color:var(--color-brand-bg)] p-6">
        <h2 className="font-[family-name:var(--font-heading)] text-sm font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          What this module will include
        </h2>
        <ul className="mt-4 space-y-2">
          {mod.highlights.map((h) => (
            <li
              key={h}
              className="flex items-start gap-2 text-sm text-[color:var(--color-brand-text)]"
            >
              <span
                aria-hidden
                className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--color-brand-cyan)]"
              />
              <span>{h}</span>
            </li>
          ))}
        </ul>
      </section>

      <p className="mt-6 text-sm text-[color:var(--color-brand-text-soft)]">
        This module isn&apos;t built yet. The placeholder exists so the
        dashboard tile has somewhere to land and so we can scope the work when
        it&apos;s prioritised.
      </p>
    </div>
  );
}
