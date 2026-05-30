import { Skeleton } from "@/components/ui/skeleton";
import { Panel } from "@/components/ui/panel";

export default function Loading() {
  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Header: title + filter tabs */}
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <Skeleton className="h-9 w-48 mb-2" />
          <Skeleton className="h-4 w-64" />
        </div>
        <nav className="flex gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-24 rounded-full" />
          ))}
        </nav>
      </header>

      {/* Queue table */}
      <Panel className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-[color:var(--color-brand-bg)]">
            <tr>
              {["Requested", "Patient", "Test", "Status", "Action"].map((col) => (
                <th key={col} className="px-4 py-3">
                  <Skeleton className="h-3 w-16" />
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {Array.from({ length: 6 }).map((_, i) => (
              <tr key={i}>
                <td className="px-4 py-3">
                  <Skeleton className="h-4 w-24" />
                </td>
                <td className="px-4 py-3">
                  <Skeleton className="h-4 w-36 mb-1" />
                  <Skeleton className="h-3 w-20" />
                </td>
                <td className="px-4 py-3">
                  <Skeleton className="h-4 w-40 mb-1" />
                  <Skeleton className="h-3 w-16" />
                </td>
                <td className="px-4 py-3">
                  <Skeleton className="h-5 w-20 rounded-md" />
                </td>
                <td className="px-4 py-3 text-right">
                  <Skeleton className="h-8 w-20 rounded-md ml-auto" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
