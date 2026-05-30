import { Skeleton } from "@/components/ui/skeleton";
import { Panel } from "@/components/ui/panel";

export default function Loading() {
  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Dashboard header: greeting + role label */}
      <div className="mb-8">
        <Skeleton className="h-4 w-32 mb-2" />
        <Skeleton className="h-8 w-64" />
      </div>

      {/* Section heading */}
      <Skeleton className="h-5 w-40 mb-4" />

      {/* Stat cards grid — 4 columns on xl, 2 on sm */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4 mb-8">
        {Array.from({ length: 4 }).map((_, i) => (
          <Panel
            key={i}
            className="p-5"
          >
            <Skeleton className="h-3 w-24 mb-3" />
            <Skeleton className="h-8 w-20 mb-2" />
            <Skeleton className="h-3 w-32" />
          </Panel>
        ))}
      </div>

      {/* Second section heading */}
      <Skeleton className="h-5 w-40 mb-4" />

      {/* Second row of stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4 mb-8">
        {Array.from({ length: 2 }).map((_, i) => (
          <Panel
            key={i}
            className="p-5"
          >
            <Skeleton className="h-3 w-24 mb-3" />
            <Skeleton className="h-8 w-20 mb-2" />
            <Skeleton className="h-3 w-32" />
          </Panel>
        ))}
      </div>

      {/* Activity strip: recent items list */}
      <Skeleton className="h-5 w-40 mb-4" />
      <Panel className="divide-y divide-[color:var(--color-brand-bg-mid)]">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center justify-between px-4 py-3">
            <div className="flex flex-col gap-1.5">
              <Skeleton className="h-3.5 w-36" />
              <Skeleton className="h-3 w-24" />
            </div>
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </Panel>
    </div>
  );
}
