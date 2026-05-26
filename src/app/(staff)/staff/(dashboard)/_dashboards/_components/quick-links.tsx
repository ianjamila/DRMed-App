import Link from "next/link";

export interface QuickLink {
  href: string;
  label: string;
}

interface QuickLinksProps {
  items: QuickLink[];
}

export function QuickLinks({ items }: QuickLinksProps) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className="inline-flex min-h-11 items-center rounded-full border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-2 text-sm font-medium text-[color:var(--color-brand-navy)] transition-colors hover:border-[color:var(--color-brand-cyan)] hover:bg-[color:var(--color-brand-bg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand-cyan)]"
        >
          {item.label}
        </Link>
      ))}
    </div>
  );
}
