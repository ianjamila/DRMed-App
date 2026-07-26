"use client";

import { useState } from "react";
import { deriveEnabledParamIds } from "@/lib/results/enabled-params";

interface PreviewParam {
  id: string;
  parameter_name: string;
  gender: string | null;
  unit_si: string | null;
  unit_conv: string | null;
  sort_order: number;
}

interface PreviewService {
  id: string;
  code: string;
  kind: string;
}

// Simulates the medtech consolidated encoding form: tick the services a visit
// "ordered" and see exactly which fields enable. The 2-month CHEMISTRY outage
// was a broken ENTRY FORM — a PDF preview alone would not have shown 13
// missing fields. Uses the same deriveEnabledParamIds as the real form.
export function EncodingPreview(props: {
  groupName: string;
  services: PreviewService[];
  params: PreviewParam[];
  links: { service_id: string; parameter_id: string }[];
}) {
  const [ordered, setOrdered] = useState<Set<string>>(
    () => new Set(props.services.map((s) => s.id)),
  );

  if (props.params.length === 0) return null;

  const enabled = deriveEnabledParamIds(props.links, [...ordered]);
  const sorted = [...props.params].sort((a, b) => a.sort_order - b.sort_order);

  function toggle(id: string) {
    setOrdered((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <section className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
      <h3 className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
        Encoding form preview
      </h3>
      <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
        What the medtech sees on the consolidated {props.groupName} form. Tick
        the services a hypothetical visit ordered — greyed rows are disabled,
        exactly as on the real form. Save the template first to preview
        unsaved mapping changes.
      </p>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {props.services.map((s) => {
          const on = ordered.has(s.id);
          return (
            <button
              key={s.id}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(s.id)}
              className={
                on
                  ? "rounded-md bg-[color:var(--color-brand-cyan)] px-2 py-1 font-mono text-[10px] font-bold text-white"
                  : "rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-1 font-mono text-[10px] text-[color:var(--color-brand-text-mid)] hover:bg-[color:var(--color-brand-bg)]"
              }
            >
              {s.code}
              {s.kind === "lab_package" ? " (header)" : ""}
            </button>
          );
        })}
      </div>

      <div className="mt-3 overflow-x-auto rounded-lg border border-[color:var(--color-brand-bg-mid)]">
        <table className="w-full text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-3 py-2">Test</th>
              <th className="px-3 py-2">Gender</th>
              <th className="px-3 py-2">SI Unit</th>
              <th className="px-3 py-2">Conv Unit</th>
              <th className="px-3 py-2">State</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {sorted.map((p) => {
              const on = enabled.has(p.id);
              return (
                <tr key={p.id} className={on ? "" : "opacity-40"}>
                  <td className="px-3 py-2 font-medium text-[color:var(--color-brand-navy)]">
                    {p.parameter_name}
                  </td>
                  <td className="px-3 py-2 text-[color:var(--color-brand-text-soft)]">
                    {p.gender ?? "Any"}
                  </td>
                  <td className="px-3 py-2 text-[color:var(--color-brand-text-soft)]">
                    {p.unit_si ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-[color:var(--color-brand-text-soft)]">
                    {p.unit_conv ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    {on ? (
                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700">
                        Enabled
                      </span>
                    ) : (
                      <span className="rounded bg-[color:var(--color-brand-bg-mid)] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                        Disabled
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
