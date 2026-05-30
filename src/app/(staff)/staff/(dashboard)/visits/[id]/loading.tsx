import { Skeleton } from "@/components/ui/skeleton";
import { Panel } from "@/components/ui/panel";

export default function Loading() {
  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Back link */}
      <Skeleton className="h-3 w-48" />

      {/* Header: visit number line + patient name + action buttons */}
      <header className="mt-3 flex flex-wrap items-center justify-between gap-4">
        <div>
          <Skeleton className="h-4 w-40 mb-2" />
          <Skeleton className="h-9 w-64" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-24 rounded-md" />
          <Skeleton className="h-9 w-36 rounded-md" />
        </div>
      </header>

      {/* Summary stat cards: Total / Paid / Balance / Status */}
      <section className="mt-6 grid gap-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i}>
            <Skeleton className="h-3 w-16 mb-2" />
            <Skeleton className="h-8 w-24" />
          </div>
        ))}
      </section>

      {/* Tests section */}
      <section className="mt-8">
        <Skeleton className="h-6 w-16 mb-3" />
        <Panel className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-[color:var(--color-brand-bg)]">
              <tr>
                {["Service", "Base", "Discount", "Final", "Status", "Action"].map((col) => (
                  <th key={col} className="px-4 py-3">
                    <Skeleton className="h-3 w-14" />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
              {Array.from({ length: 4 }).map((_, i) => (
                <tr key={i}>
                  <td className="px-4 py-3">
                    <Skeleton className="h-4 w-40 mb-1" />
                    <Skeleton className="h-3 w-20" />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Skeleton className="h-4 w-16 ml-auto" />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Skeleton className="h-4 w-6 ml-auto" />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Skeleton className="h-4 w-16 ml-auto" />
                  </td>
                  <td className="px-4 py-3">
                    <Skeleton className="h-5 w-20 rounded-md" />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Skeleton className="h-4 w-20 ml-auto" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </section>

      {/* Payments section */}
      <section className="mt-8">
        <Skeleton className="h-6 w-24 mb-3" />
        <Panel className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-[color:var(--color-brand-bg)]">
              <tr>
                {["Date", "Amount", "Method", "Reference", ""].map((col, i) => (
                  <th key={i} className="px-4 py-3">
                    {col ? <Skeleton className="h-3 w-14" /> : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
              {Array.from({ length: 2 }).map((_, i) => (
                <tr key={i}>
                  <td className="px-4 py-3">
                    <Skeleton className="h-4 w-32" />
                  </td>
                  <td className="px-4 py-3">
                    <Skeleton className="h-4 w-20" />
                  </td>
                  <td className="px-4 py-3">
                    <Skeleton className="h-4 w-16" />
                  </td>
                  <td className="px-4 py-3">
                    <Skeleton className="h-4 w-24" />
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

      {/* Back button */}
      <Skeleton className="mt-8 h-9 w-36 rounded-md" />
    </div>
  );
}
