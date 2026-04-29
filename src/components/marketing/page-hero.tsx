interface PageHeroProps {
  eyebrow?: string;
  title: string;
  description?: string;
}

export function PageHero({ eyebrow, title, description }: PageHeroProps) {
  return (
    <section className="bg-gradient-to-b from-[color:var(--color-brand-bg)] to-white">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 md:py-20 lg:px-8">
        {eyebrow ? (
          <p className="mb-3 inline-flex items-center gap-3 text-xs font-bold uppercase tracking-[0.18em] text-[color:var(--color-brand-cyan)]">
            <span className="h-px w-8 bg-[color:var(--color-brand-cyan)]" />
            {eyebrow}
          </p>
        ) : null}
        <h1 className="font-[family-name:var(--font-heading)] text-4xl font-extrabold text-[color:var(--color-brand-navy)] md:text-5xl">
          {title}
        </h1>
        {description ? (
          <p className="mt-4 max-w-2xl text-base text-[color:var(--color-brand-text-mid)] md:text-lg">
            {description}
          </p>
        ) : null}
      </div>
    </section>
  );
}
