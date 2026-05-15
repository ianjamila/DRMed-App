"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  filterParamsForPatient,
  formatRefRange,
  pickRangeForPatient,
  type EffectiveRange,
  type ParamValue,
  type PatientSex,
  type ResultLayout,
  type TemplateParam,
} from "@/lib/results/types";
import {
  saveDraftAction,
  finaliseStructuredAction,
  type StructuredPayload,
  type StructuredResult,
  type StructuredValueInput,
} from "./actions";

interface Props {
  testRequestId: string;
  layout: ResultLayout;
  params: TemplateParam[];
  patientSex: PatientSex;
  // Patient's age in months at the time the form is rendered. Used to
  // pick the right age-banded reference range per parameter (Phase 13.3).
  patientAgeMonths: number | null;
  // Initial values for re-opening a draft. Keyed by param.id.
  initial: Record<string, ParamValue>;
  // True when the result is already finalised — render the form read-only,
  // letting pathologists / admin only resubmit through sign-off.
  alreadyFinalised: boolean;
}

// Local form state per parameter.
type LocalValue = StructuredValueInput;

function emptyValue(): LocalValue {
  return {
    numeric_value_si: null,
    numeric_value_conv: null,
    text_value: null,
    select_value: null,
    is_blank: false,
  };
}

function fromInitial(v: ParamValue): LocalValue {
  return {
    numeric_value_si: v.numeric_value_si,
    numeric_value_conv: v.numeric_value_conv,
    text_value: v.text_value,
    select_value: v.select_value,
    is_blank: v.is_blank,
  };
}

function isOutOfRange(
  p: TemplateParam,
  v: LocalValue,
  range: EffectiveRange,
): boolean {
  if (v.is_blank) return false;
  if (p.input_type !== "numeric") return false;
  const x = v.numeric_value_si ?? v.numeric_value_conv;
  if (x == null) return false;
  if (range.ref_low_si != null && x < range.ref_low_si) return true;
  if (range.ref_high_si != null && x > range.ref_high_si) return true;
  return false;
}

function isAbnormalSelect(p: TemplateParam, v: LocalValue): boolean {
  if (v.is_blank) return false;
  if (p.input_type !== "select") return false;
  if (!v.select_value) return false;
  return (p.abnormal_values ?? []).includes(v.select_value);
}

export function StructuredResultForm(props: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [feedback, setFeedback] = useState<StructuredResult | null>(null);
  // Imaging-report layouts require an image attachment at finalise time.
  // Drafts skip it; the user picks the file just before clicking Finalise.
  const [image, setImage] = useState<File | null>(null);

  const visibleParams = useMemo(
    () => filterParamsForPatient(props.params, props.patientSex),
    [props.params, props.patientSex],
  );

  // Resolve the effective reference range per visible param given the
  // patient's age + sex. Falls back to the param's defaults when no
  // age-banded override matches.
  const rangesByParam = useMemo(() => {
    const out = new Map<string, EffectiveRange>();
    for (const p of visibleParams) {
      if (!p.is_section_header) {
        out.set(
          p.id,
          pickRangeForPatient(p, props.patientSex, props.patientAgeMonths),
        );
      }
    }
    return out;
  }, [visibleParams, props.patientSex, props.patientAgeMonths]);

  const [values, setValues] = useState<Record<string, LocalValue>>(() => {
    const init: Record<string, LocalValue> = {};
    for (const p of visibleParams) {
      if (p.is_section_header) continue;
      const seed = props.initial[p.id];
      init[p.id] = seed ? fromInitial(seed) : emptyValue();
    }
    return init;
  });

  function update(paramId: string, patch: Partial<LocalValue>) {
    setValues((prev) => ({ ...prev, [paramId]: { ...prev[paramId], ...patch } }));
  }

  function handleNumeric(p: TemplateParam, kind: "si" | "conv", raw: string) {
    const num = raw === "" ? null : Number(raw);
    if (num != null && Number.isNaN(num)) return;
    if (p.si_to_conv_factor != null && num != null) {
      // Auto-fill the other column.
      if (kind === "si") {
        const conv = round2(num * p.si_to_conv_factor);
        update(p.id, {
          numeric_value_si: num,
          numeric_value_conv: conv,
          is_blank: false,
        });
      } else {
        const si = round2(num / p.si_to_conv_factor);
        update(p.id, {
          numeric_value_conv: num,
          numeric_value_si: si,
          is_blank: false,
        });
      }
      return;
    }
    update(p.id, {
      [kind === "si" ? "numeric_value_si" : "numeric_value_conv"]: num,
      is_blank: false,
    });
  }

  function buildPayload(): StructuredPayload {
    return { values };
  }

  function submit(action: "draft" | "finalise") {
    setFeedback(null);
    if (action === "finalise" && props.layout === "imaging_report" && !image) {
      setFeedback({
        ok: false,
        error: "Please attach an image before finalising.",
      });
      return;
    }
    start(async () => {
      if (action === "draft") {
        const result = await saveDraftAction(
          props.testRequestId,
          buildPayload(),
        );
        setFeedback(result);
        if (result.ok) router.refresh();
        return;
      }
      // Finalise — wrap payload in FormData so we can carry the optional
      // image File alongside the values JSON. The "values" field carries
      // the full `{ values: ... }` payload shape (matches what
      // saveDraftAction takes) so finaliseStructuredAction's JSON parse
      // can read `parsed.values` directly.
      const fd = new FormData();
      fd.append("values", JSON.stringify(buildPayload()));
      if (props.layout === "imaging_report" && image) {
        fd.append("image", image);
      }
      const result = await finaliseStructuredAction(props.testRequestId, fd);
      setFeedback(result);
      if (result.ok) router.refresh();
    });
  }

  const disabled = props.alreadyFinalised || pending;
  const finaliseDisabled =
    disabled || (props.layout === "imaging_report" && !image);

  return (
    <form
      onSubmit={(e) => e.preventDefault()}
      className="grid gap-5"
    >
      {props.layout === "simple" || props.layout === "multi_section" ? (
        <SimpleOrMultiSectionBody
          layout={props.layout}
          params={visibleParams}
          values={values}
          ranges={rangesByParam}
          disabled={disabled}
          onChangeNumeric={handleNumeric}
          onSetValue={update}
        />
      ) : null}
      {props.layout === "dual_unit" ? (
        <DualUnitBody
          params={visibleParams}
          values={values}
          ranges={rangesByParam}
          disabled={disabled}
          onChangeNumeric={handleNumeric}
          onSetValue={update}
        />
      ) : null}
      {props.layout === "imaging_report" ? (
        <ImagingBody
          params={visibleParams}
          values={values}
          ranges={rangesByParam}
          disabled={disabled}
          onSetValue={update}
          image={image}
          onImageChange={setImage}
        />
      ) : null}

      {feedback && !feedback.ok ? (
        <p
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          role="alert"
        >
          {feedback.error}
        </p>
      ) : null}
      {feedback?.ok ? (
        <p
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700"
          role="status"
        >
          ✓ Saved.
          {feedback.controlNo != null
            ? ` Control No. ${feedback.controlNo.toString().padStart(6, "0")} — finalised.`
            : ""}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          disabled={disabled}
          onClick={() => submit("draft")}
          className="bg-white text-[color:var(--color-brand-navy)] ring-1 ring-inset ring-[color:var(--color-brand-bg-mid)] hover:bg-[color:var(--color-brand-bg)]"
        >
          {pending ? "Saving…" : "Save draft"}
        </Button>
        <Button
          type="button"
          disabled={finaliseDisabled}
          onClick={() => submit("finalise")}
          className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          {pending ? "Finalising…" : "Finalise & generate PDF"}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Layout: simple + multi_section share the same row UI; multi_section just
// adds visible group titles for `section`.
// ---------------------------------------------------------------------------

interface BodyProps {
  params: TemplateParam[];
  values: Record<string, LocalValue>;
  ranges: Map<string, EffectiveRange>;
  disabled: boolean;
  onChangeNumeric: (
    p: TemplateParam,
    kind: "si" | "conv",
    raw: string,
  ) => void;
  onSetValue: (paramId: string, patch: Partial<LocalValue>) => void;
}

function SimpleOrMultiSectionBody({
  layout,
  ...props
}: BodyProps & { layout: "simple" | "multi_section" }) {
  if (layout === "simple") {
    return (
      <div className="overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        {props.params.map((p) => (
          <SingleRow key={p.id} p={p} {...props} />
        ))}
      </div>
    );
  }

  // multi_section: group params by section header rows.
  type Group = { title: string | null; rows: TemplateParam[] };
  const groups: Group[] = [];
  let current: Group | null = null;
  for (const p of props.params) {
    if (p.is_section_header) {
      current = { title: p.parameter_name, rows: [] };
      groups.push(current);
      continue;
    }
    if (!current || current.title !== (p.section ?? null)) {
      current = { title: p.section ?? null, rows: [] };
      groups.push(current);
    }
    current.rows.push(p);
  }

  return (
    <div className="grid gap-4">
      {groups.map((g, i) => (
        <div
          key={i}
          className="overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white"
        >
          {g.title ? (
            <div className="bg-[color:var(--color-brand-navy)] px-4 py-2 text-xs font-bold uppercase tracking-wider text-white">
              {g.title}
            </div>
          ) : null}
          {g.rows.map((p) => (
            <SingleRow key={p.id} p={p} {...props} />
          ))}
        </div>
      ))}
    </div>
  );
}

// One row of the simple/multi_section grid.
function SingleRow({
  p,
  values,
  ranges,
  disabled,
  onChangeNumeric,
  onSetValue,
}: BodyProps & { p: TemplateParam }) {
  if (p.is_section_header) {
    return (
      <div className="border-b border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)]">
        {p.parameter_name}
      </div>
    );
  }

  const v = values[p.id] ?? emptyValue();
  const eff = ranges.get(p.id) ?? {
    ref_low_si: p.ref_low_si,
    ref_high_si: p.ref_high_si,
    ref_low_conv: p.ref_low_conv,
    ref_high_conv: p.ref_high_conv,
    critical_low_si: null,
    critical_high_si: null,
    band_label: null,
  };
  const out = isOutOfRange(p, v, eff);
  const abn = isAbnormalSelect(p, v);
  const range = formatRefRange(eff.ref_low_si, eff.ref_high_si);

  return (
    <div className="grid grid-cols-12 items-center gap-3 border-b border-[color:var(--color-brand-bg-mid)] px-4 py-2 last:border-b-0">
      <div className="col-span-12 sm:col-span-4">
        <p className="text-sm font-semibold text-[color:var(--color-brand-navy)]">
          {p.parameter_name}
        </p>
        {p.unit_si || range ? (
          <p className="text-[10px] text-[color:var(--color-brand-text-soft)]">
            {p.unit_si ?? ""}
            {p.unit_si && range ? " · " : ""}
            {range ? `Ref ${range}` : ""}
            {eff.band_label ? ` (${eff.band_label})` : ""}
          </p>
        ) : null}
      </div>
      <div className="col-span-9 sm:col-span-6">
        {p.input_type === "numeric" ? (
          <input
            type="number"
            inputMode="decimal"
            step="any"
            disabled={disabled || v.is_blank}
            value={v.numeric_value_si ?? ""}
            onChange={(e) => onChangeNumeric(p, "si", e.target.value)}
            className={`w-full rounded-md border bg-white px-3 py-1.5 font-mono text-sm focus:outline-none ${
              out
                ? "border-red-400 text-red-700 focus:border-red-500"
                : "border-[color:var(--color-brand-bg-mid)] focus:border-[color:var(--color-brand-cyan)]"
            } ${disabled || v.is_blank ? "opacity-50" : ""}`}
            placeholder={v.is_blank ? "—" : ""}
          />
        ) : null}
        {p.input_type === "select" ? (
          <select
            disabled={disabled || v.is_blank}
            value={v.select_value ?? ""}
            onChange={(e) =>
              onSetValue(p.id, {
                select_value: e.target.value || null,
                is_blank: false,
              })
            }
            className={`w-full rounded-md border bg-white px-3 py-1.5 text-sm focus:outline-none ${
              abn
                ? "border-red-400 text-red-700 focus:border-red-500"
                : "border-[color:var(--color-brand-bg-mid)] focus:border-[color:var(--color-brand-cyan)]"
            } ${disabled || v.is_blank ? "opacity-50" : ""}`}
          >
            <option value="">—</option>
            {(p.allowed_values ?? []).map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        ) : null}
        {p.input_type === "free_text" ? (
          <input
            type="text"
            disabled={disabled || v.is_blank}
            value={v.text_value ?? ""}
            onChange={(e) =>
              onSetValue(p.id, {
                text_value: e.target.value || null,
                is_blank: false,
              })
            }
            placeholder={v.is_blank ? "—" : (p.placeholder ?? "")}
            className={`w-full rounded-md border bg-white px-3 py-1.5 text-sm focus:outline-none border-[color:var(--color-brand-bg-mid)] focus:border-[color:var(--color-brand-cyan)] ${
              disabled || v.is_blank ? "opacity-50" : ""
            }`}
          />
        ) : null}
      </div>
      <div className="col-span-3 sm:col-span-2 text-right">
        <label className="inline-flex items-center gap-1.5 text-xs text-[color:var(--color-brand-text-soft)]">
          <input
            type="checkbox"
            disabled={disabled}
            checked={v.is_blank}
            onChange={(e) =>
              onSetValue(p.id, {
                is_blank: e.target.checked,
                ...(e.target.checked
                  ? {
                      numeric_value_si: null,
                      numeric_value_conv: null,
                      text_value: null,
                      select_value: null,
                    }
                  : {}),
              })
            }
            className="h-3.5 w-3.5 rounded border-[color:var(--color-brand-bg-mid)]"
          />
          Blank
        </label>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout: dual_unit
// ---------------------------------------------------------------------------

function DualUnitBody({
  params,
  values,
  ranges,
  disabled,
  onChangeNumeric,
  onSetValue,
}: BodyProps) {
  return (
    <div className="overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
      <div className="grid grid-cols-12 gap-3 bg-[color:var(--color-brand-navy)] px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-white">
        <div className="col-span-3">Test</div>
        <div className="col-span-3">SI</div>
        <div className="col-span-3">Conv.</div>
        <div className="col-span-2">Blank</div>
      </div>
      {params.map((p) => {
        if (p.is_section_header) {
          return (
            <div
              key={p.id}
              className="border-b border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)]"
            >
              {p.parameter_name}
            </div>
          );
        }
        const v = values[p.id] ?? emptyValue();
        const eff = ranges.get(p.id) ?? {
          ref_low_si: p.ref_low_si,
          ref_high_si: p.ref_high_si,
          ref_low_conv: p.ref_low_conv,
          ref_high_conv: p.ref_high_conv,
          critical_low_si: null,
          critical_high_si: null,
          band_label: null,
        };
        const out = isOutOfRange(p, v, eff);
        return (
          <div
            key={p.id}
            className="grid grid-cols-12 items-center gap-3 border-b border-[color:var(--color-brand-bg-mid)] px-4 py-2 last:border-b-0"
          >
            <div className="col-span-12 sm:col-span-3">
              <p className="text-sm font-semibold text-[color:var(--color-brand-navy)]">
                {p.parameter_name}
              </p>
              {eff.band_label ? (
                <p className="text-[10px] text-[color:var(--color-brand-text-soft)]">
                  {eff.band_label}
                </p>
              ) : null}
            </div>
            <div className="col-span-6 sm:col-span-3">
              <input
                type="number"
                inputMode="decimal"
                step="any"
                disabled={disabled || v.is_blank}
                value={v.numeric_value_si ?? ""}
                onChange={(e) => onChangeNumeric(p, "si", e.target.value)}
                className={`w-full rounded-md border bg-white px-3 py-1.5 font-mono text-sm focus:outline-none ${
                  out
                    ? "border-red-400 text-red-700 focus:border-red-500"
                    : "border-[color:var(--color-brand-bg-mid)] focus:border-[color:var(--color-brand-cyan)]"
                } ${disabled || v.is_blank ? "opacity-50" : ""}`}
              />
              <p className="mt-0.5 text-[10px] text-[color:var(--color-brand-text-soft)]">
                {p.unit_si ?? ""}
                {formatRefRange(eff.ref_low_si, eff.ref_high_si)
                  ? ` · ${formatRefRange(eff.ref_low_si, eff.ref_high_si)}`
                  : ""}
              </p>
            </div>
            <div className="col-span-6 sm:col-span-3">
              <input
                type="number"
                inputMode="decimal"
                step="any"
                disabled={disabled || v.is_blank}
                value={v.numeric_value_conv ?? ""}
                onChange={(e) => onChangeNumeric(p, "conv", e.target.value)}
                className={`w-full rounded-md border bg-white px-3 py-1.5 font-mono text-sm focus:outline-none ${
                  out
                    ? "border-red-400 text-red-700 focus:border-red-500"
                    : "border-[color:var(--color-brand-bg-mid)] focus:border-[color:var(--color-brand-cyan)]"
                } ${disabled || v.is_blank ? "opacity-50" : ""}`}
              />
              <p className="mt-0.5 text-[10px] text-[color:var(--color-brand-text-soft)]">
                {p.unit_conv ?? ""}
                {formatRefRange(eff.ref_low_conv, eff.ref_high_conv)
                  ? ` · ${formatRefRange(eff.ref_low_conv, eff.ref_high_conv)}`
                  : ""}
              </p>
            </div>
            <div className="col-span-12 sm:col-span-2 sm:text-right">
              <label className="inline-flex items-center gap-1.5 text-xs text-[color:var(--color-brand-text-soft)]">
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={v.is_blank}
                  onChange={(e) =>
                    onSetValue(p.id, {
                      is_blank: e.target.checked,
                      ...(e.target.checked
                        ? {
                            numeric_value_si: null,
                            numeric_value_conv: null,
                          }
                        : {}),
                    })
                  }
                  className="h-3.5 w-3.5 rounded border-[color:var(--color-brand-bg-mid)]"
                />
                Blank
              </label>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout: imaging_report
// ---------------------------------------------------------------------------

function ImagingBody({
  params,
  values,
  disabled,
  onSetValue,
  image,
  onImageChange,
}: Omit<BodyProps, "onChangeNumeric"> & {
  image: File | null;
  onImageChange: (f: File | null) => void;
}) {
  return (
    <div className="grid gap-4">
      {params.map((p) => {
        if (p.is_section_header) return null;
        const v = values[p.id] ?? emptyValue();
        return (
          <div
            key={p.id}
            className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4"
          >
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)]">
                {p.parameter_name}
              </p>
              <label className="inline-flex items-center gap-1.5 text-xs text-[color:var(--color-brand-text-soft)]">
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={v.is_blank}
                  onChange={(e) =>
                    onSetValue(p.id, {
                      is_blank: e.target.checked,
                      ...(e.target.checked ? { text_value: null } : {}),
                    })
                  }
                  className="h-3.5 w-3.5 rounded border-[color:var(--color-brand-bg-mid)]"
                />
                Blank
              </label>
            </div>
            <textarea
              disabled={disabled || v.is_blank}
              value={v.text_value ?? ""}
              onChange={(e) =>
                onSetValue(p.id, {
                  text_value: e.target.value || null,
                  is_blank: false,
                })
              }
              rows={5}
              placeholder={p.placeholder ?? ""}
              className="w-full resize-y rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 font-mono text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            />
          </div>
        );
      })}

      <div className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4">
        <div className="mb-2 flex items-center justify-between">
          <label
            htmlFor="imaging-image"
            className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)]"
          >
            Attached image <span className="text-red-600">*</span>
          </label>
        </div>
        <input
          id="imaging-image"
          type="file"
          accept="image/jpeg,image/png,image/webp,application/pdf"
          onChange={(e) => onImageChange(e.target.files?.[0] ?? null)}
          disabled={disabled}
          required
          className="block w-full min-h-[44px] text-sm text-[color:var(--color-brand-ink)] file:mr-3 file:rounded-md file:border-0 file:bg-[color:var(--color-brand-navy)] file:px-3 file:py-2 file:text-xs file:font-semibold file:uppercase file:tracking-wider file:text-white hover:file:bg-[color:var(--color-brand-cyan)] disabled:opacity-50"
        />
        {image ? (
          <p className="mt-2 text-xs text-[color:var(--color-brand-text-soft)]">
            Selected: <span className="font-medium">{image.name}</span> (
            {(image.size / 1024 / 1024).toFixed(2)} MB)
          </p>
        ) : null}
        <p className="mt-1 text-[11px] text-[color:var(--color-brand-text-soft)]">
          JPEG, PNG, WebP, or PDF — up to 25 MB. The image embeds in the
          released PDF; PDFs are listed as separate attachments.
        </p>
      </div>
    </div>
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
