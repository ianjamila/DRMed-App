interface SectionHeadingProps {
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
  defaultOpen?: boolean;
  collapsible?: boolean;
}

// Renders a dashboard section. When `children` are passed, the section is
// wrapped in a <details>/<summary> so it can be collapsed (defaults to open).
// When no children are passed it falls back to a bare heading — for use
// cases where the caller still wants to render the content directly below.
export function SectionHeading({
  title,
  subtitle,
  children,
  defaultOpen = true,
  collapsible = true,
}: SectionHeadingProps) {
  if (!children) {
    return (
      <div className="mb-3 mt-8 first:mt-0">
        <h2 className="font-heading text-xl font-bold text-[color:var(--color-brand-navy)]">
          {title}
        </h2>
        {subtitle ? (
          <p className="mt-0.5 text-sm text-[color:var(--color-brand-text-soft)]">{subtitle}</p>
        ) : null}
      </div>
    );
  }

  if (!collapsible) {
    return (
      <section className="mt-8 first:mt-0">
        <div className="mb-3">
          <h2 className="font-heading text-xl font-bold text-[color:var(--color-brand-navy)]">
            {title}
          </h2>
          {subtitle ? (
            <p className="mt-0.5 text-sm text-[color:var(--color-brand-text-soft)]">
              {subtitle}
            </p>
          ) : null}
        </div>
        {children}
      </section>
    );
  }

  return (
    <details
      className="group mt-8 first:mt-0 [&[open]>summary>.chevron]:rotate-90"
      open={defaultOpen}
    >
      <summary className="mb-3 flex cursor-pointer list-none items-center gap-2 outline-none [&::-webkit-details-marker]:hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-brand-cyan)]">
        <span
          aria-hidden
          className="chevron inline-block text-[color:var(--color-brand-text-soft)] transition-transform duration-150"
        >
          ▸
        </span>
        <div>
          <h2 className="font-heading text-xl font-bold text-[color:var(--color-brand-navy)]">
            {title}
          </h2>
          {subtitle ? (
            <p className="mt-0.5 text-sm text-[color:var(--color-brand-text-soft)]">
              {subtitle}
            </p>
          ) : null}
        </div>
      </summary>
      {children}
    </details>
  );
}
