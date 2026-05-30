import { Skeleton } from "@/components/ui/skeleton";
import { Panel } from "@/components/ui/panel";

export default function Loading() {
  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Back link */}
      <Skeleton className="h-3 w-20" />

      {/* Header: DRM-ID + full name + action buttons */}
      <header className="mt-3 flex flex-wrap items-center justify-between gap-4">
        <div>
          <Skeleton className="h-4 w-28 mb-2" />
          <Skeleton className="h-9 w-72" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-16 rounded-md" />
          <Skeleton className="h-9 w-28 rounded-md" />
        </div>
      </header>

      {/* Patient info grid — ~6 cells */}
      <section className="mt-6 grid gap-4 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5 sm:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i}>
            <Skeleton className="h-3 w-20 mb-2" />
            <Skeleton className="h-4 w-32" />
          </div>
        ))}
      </section>

      {/* Visits table */}
      <section className="mt-8">
        <Skeleton className="h-6 w-16 mb-3" />
        <Panel className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-[color:var(--color-brand-bg)]">
              <tr>
                {["Date", "Visit #", "Total", "Paid", "Status", ""].map((col, i) => (
                  <th key={i} className="px-4 py-3">
                    {col ? <Skeleton className="h-3 w-14" /> : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
              {Array.from({ length: 3 }).map((_, i) => (
                <tr key={i}>
                  <td className="px-4 py-3">
                    <Skeleton className="h-4 w-24" />
                  </td>
                  <td className="px-4 py-3">
                    <Skeleton className="h-4 w-16" />
                  </td>
                  <td className="px-4 py-3">
                    <Skeleton className="h-4 w-20" />
                  </td>
                  <td className="px-4 py-3">
                    <Skeleton className="h-4 w-20" />
                  </td>
                  <td className="px-4 py-3">
                    <Skeleton className="h-5 w-16 rounded-md" />
                  </td>
                  <td className="px-4 py-3">
                    <Skeleton className="h-4 w-12" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </section>
    </div>
  );
}
