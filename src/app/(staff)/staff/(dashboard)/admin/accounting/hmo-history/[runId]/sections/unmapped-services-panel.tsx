"use client";

import { useState, useTransition } from "react";

import { mapServiceAliasAction } from "../../actions";

interface Service {
  id: string;
  name: string;
  kind: string;
}

interface Props {
  runId: string;
  unmapped: {
    alias: string;
    kind: "lab_test" | "doctor_consultation";
    row_count: number;
  }[];
  onResolved: () => void;
  // Fetched server-side in the parent server component and passed down. Each
  // row's dropdown is filtered to the matching `kind`.
  services?: Service[];
}

export function UnmappedServicesPanel({
  runId,
  unmapped,
  onResolved,
  services = [],
}: Props) {
  if (unmapped.length === 0) return null;
  return (
    <section id="unmapped-services" className="mb-6">
      <h2 className="text-base font-semibold mb-2">
        Unmapped services / doctors{" "}
        <span className="text-red-700">({unmapped.length})</span>
      </h2>
      <p className="text-xs text-muted-foreground mb-3">
        These service names (or doctor last names for consultations) don&rsquo;t
        match any service. Map each one before commit. New rows created as{" "}
        <code>kind=lab_test</code> or <code>kind=doctor_consultation</code>{" "}
        based on which tab they came from.
      </p>
      <ul className="space-y-2">
        {unmapped.map((u) => (
          <Row
            key={u.alias}
            runId={runId}
            alias={u.alias}
            kind={u.kind}
            rowCount={u.row_count}
            services={services.filter((s) => s.kind === u.kind)}
            onResolved={onResolved}
          />
        ))}
      </ul>
    </section>
  );
}

function Row({
  runId,
  alias,
  kind,
  rowCount,
  services,
  onResolved,
}: {
  runId: string;
  alias: string;
  kind: "lab_test" | "doctor_consultation";
  rowCount: number;
  services: Service[];
  onResolved: () => void;
}) {
  const [pick, setPick] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  return (
    <li className="rounded-md border p-3 sm:flex sm:items-center sm:gap-3">
      <div className="flex-1 mb-2 sm:mb-0">
        <div className="font-medium">{alias}</div>
        <div className="text-xs text-muted-foreground">
          {rowCount} row{rowCount === 1 ? "" : "s"} · {kind}
        </div>
      </div>
      <select
        aria-label={`Pick service for ${alias}`}
        value={pick}
        onChange={(e) => setPick(e.target.value)}
        className="rounded-md border px-3 py-2 text-sm min-h-[44px] w-full sm:w-auto"
      >
        <option value="">— pick service —</option>
        {services.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
        <option value="create">
          + Create new &ldquo;{alias}&rdquo; ({kind})
        </option>
      </select>
      <button
        type="button"
        disabled={!pick || isPending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const res = await mapServiceAliasAction({
              run_id: runId,
              alias,
              service_kind: kind,
              service_id: pick as string,
            });
            if (!res.ok) setError(res.error);
            else onResolved();
          });
        }}
        className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50 min-h-[44px] mt-2 sm:mt-0"
      >
        {isPending ? "Saving…" : "Map"}
      </button>
      {error && (
        <div role="alert" className="text-xs text-red-700 mt-1 sm:ml-3">
          {error}
        </div>
      )}
    </li>
  );
}
