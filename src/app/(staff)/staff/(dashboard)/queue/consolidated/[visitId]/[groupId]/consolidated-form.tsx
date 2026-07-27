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
  enabledParamIds: string[];
  claimedBy: string | null;
  myStaffId: string;
  /** Set when the visit is still waiting for payment (item 10) — replaces the
   * claim button with a notice. Server action enforces the same gate. */
  claimBlockedHint: string | null;
}

export function ConsolidatedForm(props: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [deferredReason, setDeferredReason] = useState<
    "payment" | "consent" | null
  >(null);

  // Derived server-side from report_group_service_params — identity-based, so
  // renaming a parameter in the admin editor can't silently disable a field.
  const enabledParamIds = new Set(props.enabledParamIds);

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
      .filter((p) => enabledParamIds.has(p.id))
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
      if (res.data.releaseDeferred) {
        // Stay on the page so the medtech sees the report is finalised but
        // not yet in the patient's hands — and why.
        setDeferredReason(res.data.deferredReason ?? "payment");
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
        {/* DRM-ID + visit number deliberately omitted from result entry —
            partner revision 11: the bench identifies the patient by name. */}
        <p className="mt-1 font-semibold text-[color:var(--color-brand-navy)]">
          {props.visit.patients.last_name}, {props.visit.patients.first_name}
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
        {deferredReason ? (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
            <p className="text-sm font-semibold text-amber-900">
              Report finalised — release deferred:{" "}
              {deferredReason === "payment"
                ? "visit not yet paid; results release automatically once payment is recorded"
                : "patient consent not on file"}
            </p>
            <button
              type="button"
              onClick={() => router.push("/staff/queue")}
              className="mt-3 min-h-[44px] rounded-lg bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
            >
              Back to queue
            </button>
          </div>
        ) : !isClaimedByMe ? (
          <div>
            <p className="text-sm text-[color:var(--color-brand-text-mid)]">
              {props.claimedBy
                ? "This report is claimed by another medtech."
                : props.claimBlockedHint
                  ? "This report is unassigned."
                  : "This report is unassigned. Claim it to start working on it."}
            </p>
            {!props.claimedBy ? (
              props.claimBlockedHint ? (
                <p
                  role="status"
                  className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
                >
                  {props.claimBlockedHint}
                </p>
              ) : (
                <div className="mt-4">
                  <button
                    onClick={handleClaim}
                    disabled={pending}
                    className="min-h-[44px] rounded-lg bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
                  >
                    {pending ? "Claiming…" : "Claim this report"}
                  </button>
                </div>
              )
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

            {params.length > 0 &&
            props.orderedServiceCodes.length > 0 &&
            enabledParamIds.size === 0 ? (
              <p
                className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700"
                role="alert"
              >
                Every field below is disabled — not because nothing was
                ordered, but because none of the ordered tests map to a field
                on this template. This is a configuration problem, not a
                data-entry one. Report it to an admin instead of working
                around it.
              </p>
            ) : null}

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
                    const enabled = enabledParamIds.has(p.id);
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
