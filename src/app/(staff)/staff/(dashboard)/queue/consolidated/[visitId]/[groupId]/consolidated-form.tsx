"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { claimConsolidated, finaliseConsolidated } from "./actions";
import type { ConsolidatedFormTemplate, ConsolidatedFormVisit } from "./page";
import { normalisePatientSex } from "@/lib/results/types";

interface Props {
  group: { id: string; code: string; name: string };
  template: ConsolidatedFormTemplate;
  visit: ConsolidatedFormVisit;
  orderedServiceCodes: string[];
  testRequestIds: string[];
  claimedBy: string | null;
  myStaffId: string;
}

// Map service code → parameter_names it covers on the consolidated chemistry
// template. Verified against live DB (T3 seed, migration 0053).
const SERVICE_TO_PARAMS: Record<string, string[]> = {
  FBS_RBS: ["FBS"],
  BUN: ["BUN"],
  CREATININE: ["Creatinine"],
  BUA_URIC_ACID: ["Uric Acid"],
  TRIGLYCERIDES: ["Triglycerides"],
  CHOLESTEROL: ["Cholesterol"],
  HDL_LDL_VLDL: ["HDL", "LDL", "VLDL"],
  SGPT_ALT: ["SGPT (ALT)"],
  SGOT_AST: ["SGOT (AST)"],
  HBA1C: ["HBA1C"],
  LIPID_PROFILE: ["Triglycerides", "Cholesterol", "HDL", "LDL", "VLDL"],
};

export function ConsolidatedForm(props: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const enabledParamNames = new Set<string>(
    props.orderedServiceCodes.flatMap((c) => SERVICE_TO_PARAMS[c] ?? []),
  );

  // Filter params by gender for this patient, then sort by sort_order.
  // patients.sex is stored as 'male'/'female' in the DB; template params use
  // 'F'/'M'. normalisePatientSex bridges the two shapes.
  const patientSex = normalisePatientSex(props.visit.patients.sex);
  const params = props.template.result_template_params
    .filter((p) => !p.gender || p.gender === patientSex)
    .sort((a, b) => a.sort_order - b.sort_order);

  // Controlled state for each param's SI + conventional values.
  const [values, setValues] = useState<
    Record<string, { si: string; conv: string }>
  >({});

  function updateSi(
    paramId: string,
    factor: number | null,
    raw: string,
  ) {
    setValues((prev) => {
      const si = raw;
      const numeric = parseFloat(raw);
      const conv =
        factor && !Number.isNaN(numeric)
          ? (numeric * factor).toFixed(2)
          : (prev[paramId]?.conv ?? "");
      return { ...prev, [paramId]: { si, conv } };
    });
  }

  function updateConv(
    paramId: string,
    factor: number | null,
    raw: string,
  ) {
    setValues((prev) => {
      const conv = raw;
      const numeric = parseFloat(raw);
      const si =
        factor && factor !== 0 && !Number.isNaN(numeric)
          ? (numeric / factor).toFixed(4)
          : (prev[paramId]?.si ?? "");
      return { ...prev, [paramId]: { si, conv } };
    });
  }

  const isClaimedByMe = props.claimedBy === props.myStaffId;

  function handleClaim() {
    setError(null);
    startTransition(async () => {
      const res = await claimConsolidated({
        testRequestIds: props.testRequestIds,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  function handleFinalise() {
    setError(null);
    const payload = params
      .filter((p) => enabledParamNames.has(p.parameter_name))
      .map((p) => ({
        parameter_id: p.id,
        numeric_value_si:
          values[p.id]?.si ? parseFloat(values[p.id].si) : null,
        numeric_value_conv:
          values[p.id]?.conv ? parseFloat(values[p.id].conv) : null,
      }))
      .filter(
        (row) =>
          row.numeric_value_si != null || row.numeric_value_conv != null,
      );

    startTransition(async () => {
      const res = await finaliseConsolidated({
        visitId: props.visit.id,
        groupId: props.group.id,
        testRequestIds: props.testRequestIds,
        values: payload,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.push("/staff/queue");
    });
  }

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/staff/queue"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Queue
      </Link>

      <header className="mt-3">
        <h1 className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          {props.group.name}
        </h1>
        <p className="mt-1 font-semibold text-[color:var(--color-brand-navy)]">
          {props.visit.patients.last_name}, {props.visit.patients.first_name}
        </p>
        <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
          {props.visit.patients.drm_id} · Visit #{props.visit.visit_number}
        </p>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-sm text-[color:var(--color-brand-text-soft)]">
          <span>Ordered:</span>
          {props.orderedServiceCodes.map((code) => (
            <span
              key={code}
              className="font-mono text-xs text-[color:var(--color-brand-navy)]"
            >
              {code}
            </span>
          ))}
        </div>
      </header>

      <section className="mt-6 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
        {!isClaimedByMe ? (
          <div>
            <p className="text-sm text-[color:var(--color-brand-text-mid)]">
              {props.claimedBy
                ? "This report is claimed by another medtech."
                : "This report is unassigned. Claim it to start working on it."}
            </p>
            {!props.claimedBy ? (
              <div className="mt-4">
                <button
                  onClick={handleClaim}
                  disabled={pending}
                  className="min-h-[44px] rounded-lg bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
                >
                  {pending ? "Claiming…" : "Claim this report"}
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleFinalise();
            }}
            className="space-y-4"
          >
            <div>
              <h2 className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
                Enter result values
              </h2>
              <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
                Rows for un-ordered tests are greyed out. Enter SI or
                conventional values — the other converts automatically.
              </p>
            </div>

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
                    const enabled = enabledParamNames.has(p.parameter_name);
                    return (
                      <tr
                        key={p.id}
                        className={
                          enabled
                            ? "hover:bg-[color:var(--color-brand-bg)]"
                            : "opacity-40"
                        }
                      >
                        <td className="px-3 py-2 font-medium text-[color:var(--color-brand-navy)]">
                          {p.parameter_name}
                        </td>
                        <td className="px-3 py-2">
                          <input
                            type="number"
                            step="any"
                            disabled={!enabled || pending}
                            value={values[p.id]?.si ?? ""}
                            onChange={(e) =>
                              updateSi(
                                p.id,
                                p.si_to_conv_factor,
                                e.target.value,
                              )
                            }
                            className="w-24 rounded border border-[color:var(--color-brand-bg-mid)] px-2 py-1 text-right min-h-[44px] disabled:bg-[color:var(--color-brand-bg)] disabled:cursor-not-allowed"
                          />
                        </td>
                        <td className="px-3 py-2 text-[color:var(--color-brand-text-soft)]">
                          {p.unit_si ?? "—"}
                        </td>
                        <td className="px-3 py-2">
                          <input
                            type="number"
                            step="any"
                            disabled={!enabled || pending}
                            value={values[p.id]?.conv ?? ""}
                            onChange={(e) =>
                              updateConv(
                                p.id,
                                p.si_to_conv_factor,
                                e.target.value,
                              )
                            }
                            className="w-24 rounded border border-[color:var(--color-brand-bg-mid)] px-2 py-1 text-right min-h-[44px] disabled:bg-[color:var(--color-brand-bg)] disabled:cursor-not-allowed"
                          />
                        </td>
                        <td className="px-3 py-2 text-[color:var(--color-brand-text-soft)]">
                          {p.unit_conv ?? "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {error ? (
              <p className="rounded-lg border border-destructive bg-destructive/5 p-3 text-sm text-destructive">
                {error}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={pending}
              className="min-h-[44px] rounded-lg bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
            >
              {pending ? "Finalising…" : "Finalise + release"}
            </button>
          </form>
        )}

        {error && !isClaimedByMe ? (
          <p className="mt-3 rounded-lg border border-destructive bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </section>

      <Link
        href={`/staff/visits/${props.visit.id}`}
        className="mt-6 inline-block text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        Open visit →
      </Link>
    </div>
  );
}
