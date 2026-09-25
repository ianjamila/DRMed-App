"use client";

import { useState } from "react";
import type { ConsolidatedFormTemplate } from "./page";

export type ConsolidatedParam = ConsolidatedFormTemplate["result_template_params"][number];
export type ValueCells = Record<string, { si: string; conv: string }>;

/**
 * SI / conventional value state for the consolidated entry and edit forms.
 * Typing one side converts the other with the parameter's factor.
 */
export function useConsolidatedValues(initial: ValueCells = {}) {
  const [values, setValues] = useState<ValueCells>(initial);

  function updateSi(paramId: string, factor: number | null, raw: string) {
    setValues((prev) => {
      const numeric = parseFloat(raw);
      const conv =
        factor && !Number.isNaN(numeric)
          ? (numeric * factor).toFixed(2)
          : (prev[paramId]?.conv ?? "");
      return { ...prev, [paramId]: { si: raw, conv } };
    });
  }

  function updateConv(paramId: string, factor: number | null, raw: string) {
    setValues((prev) => {
      const numeric = parseFloat(raw);
      const si =
        factor && factor !== 0 && !Number.isNaN(numeric)
          ? (numeric / factor).toFixed(4)
          : (prev[paramId]?.si ?? "");
      return { ...prev, [paramId]: { si, conv: raw } };
    });
  }

  /** The filled-in enabled fields, as the Server Actions take them. */
  function payload(params: readonly ConsolidatedParam[], enabled: ReadonlySet<string>) {
    return params
      .filter((p) => enabled.has(p.id))
      .map((p) => ({
        parameter_id: p.id,
        numeric_value_si: values[p.id]?.si ? parseFloat(values[p.id].si) : null,
        numeric_value_conv: values[p.id]?.conv ? parseFloat(values[p.id].conv) : null,
      }))
      .filter((row) => row.numeric_value_si != null || row.numeric_value_conv != null);
  }

  return { values, updateSi, updateConv, payload };
}

export function ConsolidatedValuesTable({
  params,
  enabled,
  values,
  onSi,
  onConv,
  disabled,
}: {
  params: readonly ConsolidatedParam[];
  enabled: ReadonlySet<string>;
  values: ValueCells;
  onSi: (paramId: string, factor: number | null, raw: string) => void;
  onConv: (paramId: string, factor: number | null, raw: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-[color:var(--color-brand-bg-mid)]">
      <table className="w-full text-sm">
        <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          <tr>
            <th className="px-3 py-2">Test</th>
            <th className="px-3 py-2 text-right">SI Result</th>
            <th className="px-3 py-2">SI Unit</th>
            <th className="px-3 py-2 text-right">Conv Result</th>
            <th className="px-3 py-2">Conv Unit</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
          {params.map((p) => {
            const on = enabled.has(p.id);
            return (
              <tr key={p.id} className={on ? "hover:bg-[color:var(--color-brand-bg)]" : "opacity-40"}>
                <td className="px-3 py-2 font-medium text-[color:var(--color-brand-navy)]">
                  {p.parameter_name}
                </td>
                <td className="px-3 py-2">
                  <input
                    type="number"
                    step="any"
                    aria-label={`${p.parameter_name} SI result`}
                    disabled={!on || disabled}
                    value={values[p.id]?.si ?? ""}
                    onChange={(e) => onSi(p.id, p.si_to_conv_factor, e.target.value)}
                    className="w-24 rounded border border-[color:var(--color-brand-bg-mid)] px-2 py-1 text-right min-h-[44px] disabled:bg-[color:var(--color-brand-bg)] disabled:cursor-not-allowed"
                  />
                </td>
                <td className="px-3 py-2 text-[color:var(--color-brand-text-soft)]">{p.unit_si ?? "—"}</td>
                <td className="px-3 py-2">
                  <input
                    type="number"
                    step="any"
                    aria-label={`${p.parameter_name} conventional result`}
                    disabled={!on || disabled}
                    value={values[p.id]?.conv ?? ""}
                    onChange={(e) => onConv(p.id, p.si_to_conv_factor, e.target.value)}
                    className="w-24 rounded border border-[color:var(--color-brand-bg-mid)] px-2 py-1 text-right min-h-[44px] disabled:bg-[color:var(--color-brand-bg)] disabled:cursor-not-allowed"
                  />
                </td>
                <td className="px-3 py-2 text-[color:var(--color-brand-text-soft)]">{p.unit_conv ?? "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
