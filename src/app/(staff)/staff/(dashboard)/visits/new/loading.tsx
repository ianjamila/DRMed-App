import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Header: title + "New patient" button */}
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Skeleton className="h-9 w-24 mb-2" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-11 w-32 rounded-md" />
      </header>

      {/* Visits section tabs */}
      <div className="mb-6">
        <div className="flex gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-28 rounded-full" />
          ))}
        </div>
      </div>

      {/* Search bar */}
      <div className="mb-4">
        <Skeleton className="h-10 w-full rounded-md" />
      </div>

      {/* Patient picker list */}
      <div className="overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white divide-y divide-[color:var(--color-brand-bg-mid)]">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center justify-between px-4 py-3">
            <div className="flex flex-col gap-1.5">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-32" />
            </div>
            <Skeleton className="h-8 w-28 rounded-md" />
          </div>
        ))}
      </div>
    </div>
  );
}
