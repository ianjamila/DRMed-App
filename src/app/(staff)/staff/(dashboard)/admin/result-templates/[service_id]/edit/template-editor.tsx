"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  saveTemplateAndParamsAction,
  type SaveTemplateResult,
} from "./actions";
import type {
  TemplateEditorPayload,
  TemplateParamPayload,
} from "@/lib/validations/result-template";

interface Props {
  serviceId: string;
  serviceCode: string;
  serviceName: string;
  hasTemplate: boolean;
  // Initial values. Empty arrays / sane defaults when this is a brand-new template.
  initialLayout: TemplateEditorPayload["layout"];
  initialHeaderNotes: string | null;
  initialFooterNotes: string | null;
  initialIsActive: boolean;
  initialParams: TemplateParamPayload[];
}

const LAYOUT_OPTIONS: { value: TemplateEditorPayload["layout"]; label: string; hint: string }[] = [
  { value: "simple", label: "Simple", hint: "Single-value list (CBC, single panel tests)" },
  { value: "dual_unit", label: "Dual unit", hint: "SI + Conventional columns (chemistry panels)" },
  { value: "multi_section", label: "Multi-section", hint: "Grouped sections (urinalysis: physical / chemical / microscopic)" },
  { value: "imaging_report", label: "Imaging report", hint: "Free-text Findings + Impression (X-ray, ultrasound)" },
];

const INPUT_TYPE_OPTIONS = [
  { value: "numeric", label: "Numeric" },
  { value: "free_text", label: "Free text" },
  { value: "select", label: "Select (controlled vocab)" },
] as const;

function emptyParam(): TemplateParamPayload {
  return {
    id: null,
    parameter_name: "",
    input_type: "numeric",
    section: null,
    is_section_header: false,
    unit_si: null,
    unit_conv: null,
    ref_low_si: null,
    ref_high_si: null,
    ref_low_conv: null,
    ref_high_conv: null,
    gender: null,
    si_to_conv_factor: null,
    allowed_values: null,
    abnormal_values: null,
    placeholder: null,
  };
}

export function TemplateEditor(props: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [feedback, setFeedback] = useState<SaveTemplateResult | null>(null);

  const [layout, setLayout] = useState(props.initialLayout);
  const [headerNotes, setHeaderNotes] = useState(props.initialHeaderNotes ?? "");
  const [footerNotes, setFooterNotes] = useState(props.initialFooterNotes ?? "");
  const [isActive, setIsActive] = useState(props.initialIsActive);
  const [params, setParams] = useState<TemplateParamPayload[]>(props.initialParams);

  function updateParam(idx: number, patch: Partial<TemplateParamPayload>) {
    setParams((prev) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  }
  function addParam() {
    setParams((prev) => [...prev, emptyParam()]);
  }
  function removeParam(idx: number) {
    setParams((prev) => prev.filter((_, i) => i !== idx));
  }
  function moveParam(idx: number, direction: -1 | 1) {
    setParams((prev) => {
      const next = idx + direction;
      if (next < 0 || next >= prev.length) return prev;
      const out = [...prev];
      [out[idx], out[next]] = [out[next], out[idx]];
      return out;
    });
  }

  function submit() {
    setFeedback(null);
    start(async () => {
      const payload: TemplateEditorPayload = {
        service_id: props.serviceId,
        layout,
        header_notes: headerNotes.trim() || null,
        footer_notes: footerNotes.trim() || null,
        is_active: isActive,
        params,
      };
      const result = await saveTemplateAndParamsAction(payload);
      setFeedback(result);
      if (result.ok) router.refresh();
    });
  }

  return (
    <div className="grid gap-6">
      <header className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
        <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
          {props.serviceCode}
        </p>
        <h2 className="mt-0.5 font-[family-name:var(--font-heading)] text-2xl font-extrabold text-[color:var(--color-brand-navy)]">
          {props.serviceName}
        </h2>
        <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
          {props.hasTemplate ? "Editing existing template." : "Creating a new template."}
        </p>
      </header>

      <section className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
        <h3 className="font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
          Template settings
        </h3>
        <div className="mt-4 grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="layout">Layout</Label>
            <select
              id="layout"
              value={layout}
              onChange={(e) => setLayout(e.target.value as TemplateEditorPayload["layout"])}
              className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
            >
              {LAYOUT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label} — {o.hint}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="header_notes">Header notes (optional)</Label>
            <textarea
              id="header_notes"
              rows={2}
              maxLength={500}
              value={headerNotes}
              onChange={(e) => setHeaderNotes(e.target.value)}
              className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
              placeholder="Printed under the test title on every PDF."
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="footer_notes">Footer notes (optional)</Label>
            <textarea
              id="footer_notes"
              rows={2}
              maxLength={500}
              value={footerNotes}
              onChange={(e) => setFooterNotes(e.target.value)}
              className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
              placeholder="Printed above the medtech signature."
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
            />
            <span>Active — medtechs see this template in the queue form.</span>
          </label>
        </div>
      </section>

      <section className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
            Parameters ({params.length})
          </h3>
          <Button
            type="button"
            onClick={addParam}
            className="bg-[color:var(--color-brand-cyan)] text-white hover:bg-[color:var(--color-brand-navy)]"
          >
            + Add parameter
          </Button>
        </div>
        {params.length === 0 ? (
          <p className="rounded-md border border-dashed border-[color:var(--color-brand-bg-mid)] px-4 py-6 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            No parameters yet. Click <em>Add parameter</em> to start building this template.
          </p>
        ) : (
          <div className="grid gap-3">
            {params.map((p, idx) => (
              <ParamRow
                key={p.id ?? `new-${idx}`}
                idx={idx}
                total={params.length}
                p={p}
                onChange={(patch) => updateParam(idx, patch)}
                onRemove={() => removeParam(idx)}
                onMoveUp={() => moveParam(idx, -1)}
                onMoveDown={() => moveParam(idx, 1)}
              />
            ))}
          </div>
        )}
      </section>

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
          ✓ Template saved.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Link
          href="/staff/admin/result-templates"
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1.5 text-sm font-medium text-[color:var(--color-brand-text-mid)] hover:bg-[color:var(--color-brand-bg)]"
        >
          Cancel
        </Link>
        {props.hasTemplate ? (
          <Link
            href={`/staff/admin/result-templates/preview/${props.serviceId}`}
            target="_blank"
            rel="noopener"
            className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1.5 text-sm font-medium text-[color:var(--color-brand-text-mid)] hover:bg-[color:var(--color-brand-bg)]"
          >
            Preview PDF
          </Link>
        ) : null}
        <Button
          type="button"
          onClick={submit}
          disabled={pending}
          className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          {pending ? "Saving…" : "Save template"}
        </Button>
      </div>
    </div>
  );
}

interface ParamRowProps {
  idx: number;
  total: number;
  p: TemplateParamPayload;
  onChange: (patch: Partial<TemplateParamPayload>) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

function ParamRow({ idx, total, p, onChange, onRemove, onMoveUp, onMoveDown }: ParamRowProps) {
  const isHeader = p.is_section_header;
  const isNumeric = p.input_type === "numeric";
  const isSelect = p.input_type === "select";

  // Comma-separated string display for the array fields.
  const allowedStr = (p.allowed_values ?? []).join(", ");
  const abnormalStr = (p.abnormal_values ?? []).join(", ");

  return (
    <div className="rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          # {idx + 1}
        </span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            onClick={onMoveUp}
            disabled={idx === 0}
            className="h-7 px-2 text-xs"
            variant="outline"
          >
            ↑
          </Button>
          <Button
            type="button"
            onClick={onMoveDown}
            disabled={idx === total - 1}
            className="h-7 px-2 text-xs"
            variant="outline"
          >
            ↓
          </Button>
          <Button
            type="button"
            onClick={onRemove}
            className="h-7 px-2 text-xs bg-red-50 text-red-700 ring-1 ring-inset ring-red-200 hover:bg-red-100"
          >
            Remove
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-3">
        <div className="col-span-12 sm:col-span-6">
          <Label htmlFor={`pname-${idx}`} className="text-xs">Parameter name</Label>
          <Input
            id={`pname-${idx}`}
            value={p.parameter_name}
            onChange={(e) => onChange({ parameter_name: e.target.value })}
            placeholder="e.g. Hemoglobin"
          />
        </div>
        <div className="col-span-6 sm:col-span-3">
          <Label htmlFor={`ptype-${idx}`} className="text-xs">Input type</Label>
          <select
            id={`ptype-${idx}`}
            value={p.input_type}
            onChange={(e) =>
              onChange({ input_type: e.target.value as TemplateParamPayload["input_type"] })
            }
            disabled={isHeader}
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none disabled:opacity-50"
          >
            {INPUT_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="col-span-6 sm:col-span-3">
          <Label htmlFor={`psec-${idx}`} className="text-xs">Section</Label>
          <Input
            id={`psec-${idx}`}
            value={p.section ?? ""}
            onChange={(e) => onChange({ section: e.target.value || null })}
            placeholder="e.g. CHEMICAL"
          />
        </div>

        <div className="col-span-12">
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isHeader}
              onChange={(e) => onChange({ is_section_header: e.target.checked })}
            />
            Section heading row (no value column on the rendered form / PDF)
          </label>
        </div>

        {isNumeric && !isHeader ? (
          <>
            <div className="col-span-6 sm:col-span-3">
              <Label htmlFor={`unit-${idx}`} className="text-xs">SI unit</Label>
              <Input
                id={`unit-${idx}`}
                value={p.unit_si ?? ""}
                onChange={(e) => onChange({ unit_si: e.target.value || null })}
                placeholder="e.g. g/dL"
              />
            </div>
            <div className="col-span-3 sm:col-span-2">
              <Label className="text-xs">Ref low (SI)</Label>
              <Input
                type="number"
                step="any"
                value={p.ref_low_si ?? ""}
                onChange={(e) =>
                  onChange({ ref_low_si: e.target.value === "" ? null : Number(e.target.value) })
                }
              />
            </div>
            <div className="col-span-3 sm:col-span-2">
              <Label className="text-xs">Ref high (SI)</Label>
              <Input
                type="number"
                step="any"
                value={p.ref_high_si ?? ""}
                onChange={(e) =>
                  onChange({ ref_high_si: e.target.value === "" ? null : Number(e.target.value) })
                }
              />
            </div>
            <div className="col-span-6 sm:col-span-2">
              <Label htmlFor={`gen-${idx}`} className="text-xs">Gender</Label>
              <select
                id={`gen-${idx}`}
                value={p.gender ?? ""}
                onChange={(e) =>
                  onChange({ gender: (e.target.value as "F" | "M") || null })
                }
                className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
              >
                <option value="">Either</option>
                <option value="F">Female only</option>
                <option value="M">Male only</option>
              </select>
            </div>
            <div className="col-span-6 sm:col-span-3">
              <Label htmlFor={`uconv-${idx}`} className="text-xs">Conv unit (dual_unit only)</Label>
              <Input
                id={`uconv-${idx}`}
                value={p.unit_conv ?? ""}
                onChange={(e) => onChange({ unit_conv: e.target.value || null })}
                placeholder="e.g. mg/dL"
              />
            </div>
            <div className="col-span-3 sm:col-span-2">
              <Label className="text-xs">Ref low (conv)</Label>
              <Input
                type="number"
                step="any"
                value={p.ref_low_conv ?? ""}
                onChange={(e) =>
                  onChange({ ref_low_conv: e.target.value === "" ? null : Number(e.target.value) })
                }
              />
            </div>
            <div className="col-span-3 sm:col-span-2">
              <Label className="text-xs">Ref high (conv)</Label>
              <Input
                type="number"
                step="any"
                value={p.ref_high_conv ?? ""}
                onChange={(e) =>
                  onChange({ ref_high_conv: e.target.value === "" ? null : Number(e.target.value) })
                }
              />
            </div>
            <div className="col-span-6 sm:col-span-3">
              <Label htmlFor={`fac-${idx}`} className="text-xs">SI → Conv factor</Label>
              <Input
                id={`fac-${idx}`}
                type="number"
                step="any"
                value={p.si_to_conv_factor ?? ""}
                onChange={(e) =>
                  onChange({
                    si_to_conv_factor: e.target.value === "" ? null : Number(e.target.value),
                  })
                }
                placeholder="e.g. 18.02"
              />
            </div>
          </>
        ) : null}

        {isSelect && !isHeader ? (
          <>
            <div className="col-span-12">
              <Label htmlFor={`allowed-${idx}`} className="text-xs">
                Allowed values (comma-separated, in the order they should appear)
              </Label>
              <Input
                id={`allowed-${idx}`}
                value={allowedStr}
                onChange={(e) => onChange({ allowed_values: parseCsv(e.target.value) })}
                placeholder="NEGATIVE, TRACE, 1+, 2+, 3+"
              />
            </div>
            <div className="col-span-12">
              <Label htmlFor={`abnormal-${idx}`} className="text-xs">
                Abnormal subset (comma-separated, must match allowed values)
              </Label>
              <Input
                id={`abnormal-${idx}`}
                value={abnormalStr}
                onChange={(e) => onChange({ abnormal_values: parseCsv(e.target.value) })}
                placeholder="TRACE, 1+, 2+, 3+"
              />
            </div>
          </>
        ) : null}

        {!isNumeric && !isHeader ? (
          <div className="col-span-12">
            <Label htmlFor={`ph-${idx}`} className="text-xs">Placeholder hint</Label>
            <Input
              id={`ph-${idx}`}
              value={p.placeholder ?? ""}
              onChange={(e) => onChange({ placeholder: e.target.value || null })}
              placeholder="e.g. 1-3/HPF"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function parseCsv(s: string): string[] | null {
  const arr = s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
  return arr.length > 0 ? arr : null;
}
