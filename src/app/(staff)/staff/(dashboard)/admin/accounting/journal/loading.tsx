import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Header: back link + title + new-entry button */}
      <header className="mb-6">
        <Skeleton className="h-3 w-20" />
        <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <Skeleton className="h-9 w-56 mb-2" />
            <Skeleton className="h-4 w-48" />
          </div>
          <Skeleton className="h-11 w-44 rounded-md" />
        </div>
      </header>

      {/* Status filter tabs */}
      <nav className="mb-4 flex flex-wrap gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-11 w-20 rounded-full" />
        ))}
      </nav>

      {/* Journal entries table */}
      <section className="overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-[color:var(--color-brand-bg)]">
              <tr>
                {["Entry #", "Date", "Description", "Type (DR)", "Amount", "Source", "Status"].map(
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
                    <Skeleton className="h-4 w-20" />
                  </td>
                  <td className="px-4 py-3">
                    <Skeleton className="h-4 w-24" />
                  </td>
                  <td className="px-4 py-3">
                    <Skeleton className="h-4 w-48" />
                  </td>
                  <td className="px-4 py-3">
                    <Skeleton className="h-4 w-40" />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Skeleton className="h-4 w-20 ml-auto" />
                  </td>
                  <td className="px-4 py-3">
                    <Skeleton className="h-4 w-16" />
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
