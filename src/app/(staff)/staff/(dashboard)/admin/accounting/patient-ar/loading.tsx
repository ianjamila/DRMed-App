import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Header: back link + title + subtitle */}
      <header className="mb-6">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="mt-3 h-9 w-56" />
        <Skeleton className="mt-2 h-4 w-80" />
      </header>

      {/* Scope tabs */}
      <nav className="-mx-1 mb-4 flex flex-wrap gap-1 border-b border-[color:var(--color-brand-bg-mid)] pb-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-11 w-40 rounded-md" />
        ))}
      </nav>

      {/* Bucket summary cards */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <article
            key={i}
            className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5"
          >
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-2 h-8 w-32" />
            <Skeleton className="mt-1 h-3 w-16" />
          </article>
        ))}
      </div>

      {/* Aging table */}
      <section className="overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-[color:var(--color-brand-bg)]">
              <tr>
                {["Visit date", "Age", "Visit #", "Patient", "HMO", "Outstanding", "Status"].map(
                  (col) => (
                    <th key={col} className="px-4 py-3">
                      <Skeleton className="h-3 w-16" />
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
              {Array.from({ length: 6 }).map((_, i) => (
                <tr key={i}>
                  <td className="px-4 py-3">
                    <Skeleton className="h-4 w-24" />
                  </td>
                  <td className="px-4 py-3">
                    <Skeleton className="h-5 w-12 rounded-md" />
                  </td>
                  <td className="px-4 py-3">
                    <Skeleton className="h-4 w-16" />
                  </td>
                  <td className="px-4 py-3">
                    <Skeleton className="h-4 w-40" />
                  </td>
                  <td className="px-4 py-3">
                    <Skeleton className="h-4 w-20" />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Skeleton className="h-4 w-20 ml-auto" />
                  </td>
                  <td className="px-4 py-3">
                    <Skeleton className="h-5 w-16 rounded-md" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
