interface Props {
  parsed: number;
  skippedPostCutover: number;
  errors: number;
  warnings: number;
  unmappedProviders: number;
  unmappedServices: number;
  pending: boolean;
}

export function CountsPanel({
  parsed,
  skippedPostCutover,
  errors,
  warnings,
  unmappedProviders,
  unmappedServices,
  pending,
}: Props) {
  const pills = [
    {
      label: "Parsed",
      value: parsed,
      color: "bg-blue-50 border-blue-200 text-blue-900",
      href: "#",
    },
    {
      label: "Skipped post-cutover",
      value: skippedPostCutover,
      color: "bg-gray-50 border-gray-200 text-gray-700",
      href: "#",
    },
    {
      label: "Errors",
      value: errors,
      color: "bg-red-50 border-red-200 text-red-800",
      href: "#errors",
    },
    {
      label: "Warnings",
      value: warnings,
      color: "bg-amber-50 border-amber-200 text-amber-800",
      href: "#errors",
    },
    {
      label: "Unmapped providers",
      value: unmappedProviders,
      color: "bg-orange-50 border-orange-200 text-orange-800",
      href: "#unmapped-providers",
    },
    {
      label: "Unmapped services",
      value: unmappedServices,
      color: "bg-orange-50 border-orange-200 text-orange-800",
      href: "#unmapped-services",
    },
  ];

  return (
    <section className="mb-6">
      <h2 className="sr-only">Counts</h2>
      {pending && (
        <p className="text-sm text-muted-foreground mb-2">Validating…</p>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {pills.map((p) => (
          <a
            key={p.label}
            href={p.href}
            className={`rounded-md border px-3 py-3 ${p.color} min-h-[44px] flex flex-col justify-center`}
          >
            <div className="text-xs uppercase tracking-wide font-semibold">{p.label}</div>
            <div className="text-2xl font-semibold">{p.value.toLocaleString()}</div>
          </a>
        ))}
      </div>
    </section>
  );
}
