interface SectionHeadingProps {
  title: string;
  subtitle?: string;
}

export function SectionHeading({ title, subtitle }: SectionHeadingProps) {
  return (
    <div className="mb-3 mt-8 first:mt-0">
      <h2 className="font-[family-name:var(--font-heading)] text-xl font-bold text-[color:var(--color-brand-navy)]">
        {title}
      </h2>
      {subtitle ? (
        <p className="mt-0.5 text-sm text-[color:var(--color-brand-text-soft)]">{subtitle}</p>
      ) : null}
    </div>
  );
}
