"use client";

import { useState, useTransition } from "react";

import { mapProviderAliasAction } from "../../actions";

interface Provider {
  id: string;
  name: string;
}

interface Props {
  runId: string;
  unmapped: { alias: string; row_count: number }[];
  onResolved: () => void;
  // Fetched server-side in the parent server component and passed down for
  // the dropdown of existing providers.
  providers?: Provider[];
}

export function UnmappedProvidersPanel({
  runId,
  unmapped,
  onResolved,
  providers = [],
}: Props) {
  if (unmapped.length === 0) return null;

  return (
    <section id="unmapped-providers" className="mb-6">
      <h2 className="text-base font-semibold mb-2">
        Unmapped providers{" "}
        <span className="text-red-700">({unmapped.length})</span>
      </h2>
      <p className="text-xs text-muted-foreground mb-3">
        These provider names in the workbook don&rsquo;t match any HMO provider.
        Map each one (or create a new provider) before commit. Mappings persist
        for future imports.
      </p>
      <ul className="space-y-2">
        {unmapped.map((u) => (
          <UnmappedRow
            key={u.alias}
            runId={runId}
            alias={u.alias}
            rowCount={u.row_count}
            providers={providers}
            onResolved={onResolved}
          />
        ))}
      </ul>
    </section>
  );
}

function UnmappedRow({
  runId,
  alias,
  rowCount,
  providers,
  onResolved,
}: {
  runId: string;
  alias: string;
  rowCount: number;
  providers: Provider[];
  onResolved: () => void;
}) {
  const [pick, setPick] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <li className="rounded-md border p-3 sm:flex sm:items-center sm:gap-3">
      <div className="flex-1 mb-2 sm:mb-0">
        <div className="font-medium">{alias}</div>
        <div className="text-xs text-muted-foreground">
          {rowCount} row{rowCount === 1 ? "" : "s"}
        </div>
      </div>
      <select
        aria-label={`Pick provider for ${alias}`}
        value={pick}
        onChange={(e) => setPick(e.target.value)}
        className="rounded-md border px-3 py-2 text-sm min-h-[44px] w-full sm:w-auto"
      >
        <option value="">— pick provider —</option>
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
        <option value="create">+ Create new provider &ldquo;{alias}&rdquo;</option>
      </select>
      <button
        type="button"
        disabled={!pick || isPending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const res = await mapProviderAliasAction({
              run_id: runId,
              alias,
              provider_id: pick as string,
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
