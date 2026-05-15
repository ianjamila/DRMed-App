// Server-only React component that renders a Phase 13 result PDF using
// @react-pdf/renderer. The same document is used for medtech finalisation
// AND for the admin preview route — passing `isPreview: true` adds a faint
// "PREVIEW" watermark and replaces the control number / signature block.
//
// Keep all styling self-contained here. @react-pdf/renderer uses StyleSheet,
// not Tailwind, so the brand palette is duplicated as plain hex values.

import {
  Document,
  Page,
  View,
  Text,
  Image,
  StyleSheet,
} from "@react-pdf/renderer";
import { CONTACT, SITE } from "@/lib/marketing/site";
import {
  calculateAge,
  calculateAgeMonths,
  filterParamsForPatient,
  formatRefRange,
  pickRangeForPatient,
  type EffectiveRange,
  type ResultDocumentInput,
  type TemplateParam,
  type ParamValue,
} from "./types";

const C = {
  navy: "#284570",
  cyan: "#06aef1",
  ink: "#111827",
  inkSoft: "#374151",
  inkMuted: "#6b7280",
  border: "#e3eef9",
  borderStrong: "#cbd5e1",
  bgSoft: "#f0f6fc",
  flag: "#b91c1c",
  watermark: "#cbd5e1",
} as const;

const styles = StyleSheet.create({
  page: {
    paddingTop: 36,
    paddingBottom: 56,
    paddingHorizontal: 40,
    fontFamily: "Helvetica",
    fontSize: 9,
    color: C.ink,
  },
  watermark: {
    position: "absolute",
    top: 320,
    left: 0,
    right: 0,
    textAlign: "center",
    fontSize: 80,
    color: C.watermark,
    opacity: 0.18,
    letterSpacing: 8,
    fontFamily: "Helvetica-Bold",
  },
  letterhead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingBottom: 8,
    borderBottomWidth: 2,
    borderBottomColor: C.navy,
  },
  clinicName: {
    fontSize: 16,
    fontFamily: "Helvetica-Bold",
    color: C.navy,
    letterSpacing: 0.5,
  },
  clinicMeta: {
    marginTop: 2,
    fontSize: 8,
    color: C.inkMuted,
    lineHeight: 1.4,
  },
  controlBlock: {
    alignItems: "flex-end",
  },
  controlLabel: {
    fontSize: 7,
    color: C.inkMuted,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  controlNo: {
    fontSize: 13,
    fontFamily: "Helvetica-Bold",
    color: C.navy,
    marginTop: 1,
  },
  controlDate: {
    fontSize: 8,
    color: C.inkSoft,
    marginTop: 2,
  },

  patientBlock: {
    marginTop: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: C.bgSoft,
    borderLeftWidth: 3,
    borderLeftColor: C.cyan,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  patientCol: {
    flexDirection: "column",
  },
  patientLabel: {
    fontSize: 7,
    color: C.inkMuted,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  patientValue: {
    fontSize: 10,
    color: C.navy,
    fontFamily: "Helvetica-Bold",
    marginTop: 1,
  },
  patientSub: {
    fontSize: 8,
    color: C.inkSoft,
    marginTop: 1,
  },

  testTitle: {
    marginTop: 16,
    textAlign: "center",
    fontSize: 14,
    fontFamily: "Helvetica-Bold",
    color: C.navy,
    letterSpacing: 0.4,
  },
  testCode: {
    marginTop: 1,
    textAlign: "center",
    fontSize: 8,
    color: C.inkMuted,
    fontFamily: "Helvetica",
  },
  headerNotes: {
    marginTop: 6,
    fontSize: 8.5,
    color: C.inkSoft,
    fontStyle: "italic",
    textAlign: "center",
  },

  // Generic table row primitives.
  table: {
    marginTop: 12,
    borderTopWidth: 1,
    borderTopColor: C.borderStrong,
  },
  tr: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    minHeight: 18,
    alignItems: "center",
  },
  trHead: {
    flexDirection: "row",
    backgroundColor: C.navy,
    minHeight: 20,
    alignItems: "center",
  },
  thText: {
    color: "#ffffff",
    fontFamily: "Helvetica-Bold",
    fontSize: 8,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    paddingHorizontal: 6,
  },
  td: {
    paddingHorizontal: 6,
    paddingVertical: 4,
    fontSize: 9,
  },
  tdMono: {
    fontFamily: "Courier",
  },
  tdBold: {
    fontFamily: "Helvetica-Bold",
  },
  tdMuted: {
    color: C.inkMuted,
  },
  tdAbnormal: {
    color: C.flag,
    fontFamily: "Helvetica-Bold",
  },

  sectionHeaderRow: {
    flexDirection: "row",
    backgroundColor: C.bgSoft,
    minHeight: 18,
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  sectionHeaderText: {
    paddingHorizontal: 6,
    fontSize: 9,
    fontFamily: "Helvetica-Bold",
    color: C.navy,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },

  multiSection: {
    marginTop: 14,
  },
  multiSectionTitle: {
    backgroundColor: C.navy,
    color: "#ffffff",
    fontFamily: "Helvetica-Bold",
    fontSize: 9,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },

  imagingBody: {
    marginTop: 14,
  },
  imagingHeading: {
    fontFamily: "Helvetica-Bold",
    fontSize: 10,
    color: C.navy,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginTop: 10,
    marginBottom: 4,
  },
  imagingText: {
    fontFamily: "Courier",
    fontSize: 9.5,
    lineHeight: 1.5,
    color: C.ink,
  },
  imagingAttachmentBlock: {
    marginTop: 14,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: C.border,
  },
  imagingAttachmentImage: {
    marginTop: 6,
    maxWidth: 480,
    maxHeight: 360,
    objectFit: "contain",
  },
  imagingAttachmentNote: {
    marginTop: 4,
    fontSize: 9,
    color: C.inkSoft,
    fontStyle: "italic",
  },

  footerNotes: {
    marginTop: 14,
    fontSize: 8.5,
    color: C.inkSoft,
    fontStyle: "italic",
  },

  signatureBlock: {
    marginTop: 16,
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  signatureCol: {
    minWidth: 220,
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: C.borderStrong,
    paddingTop: 4,
  },
  signatureName: {
    fontFamily: "Helvetica-Bold",
    fontSize: 10,
    color: C.navy,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  signatureMeta: {
    marginTop: 2,
    fontSize: 8,
    color: C.inkSoft,
  },

  pageFooter: {
    position: "absolute",
    bottom: 28,
    left: 40,
    right: 40,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 7.5,
    color: C.inkMuted,
    paddingTop: 4,
    borderTopWidth: 1,
    borderTopColor: C.border,
  },
});

// Column widths (sum should be 1.0 within each table). Kept here for easy
// adjustment without hunting through the JSX.
const COLS = {
  simple: { test: 0.36, result: 0.18, flag: 0.08, unit: 0.16, ref: 0.22 },
  dualUnit: {
    test: 0.18,
    siResult: 0.12,
    siUnit: 0.1,
    siRange: 0.18,
    convResult: 0.12,
    convUnit: 0.1,
    convRange: 0.2,
  },
  multi: { test: 0.42, result: 0.18, flag: 0.08, unit: 0.12, ref: 0.2 },
} as const;

// ---------------------------------------------------------------------------
// Header / footer building blocks (shared across layouts)
// ---------------------------------------------------------------------------

function Letterhead({
  controlNo,
  finalisedAt,
}: {
  controlNo: number | null;
  finalisedAt: Date | null;
}) {
  return (
    <View style={styles.letterhead}>
      <View>
        <Text style={styles.clinicName}>{SITE.name}</Text>
        <Text style={styles.clinicMeta}>
          {CONTACT.address.line1}
          {"\n"}
          {CONTACT.address.line2}, {CONTACT.address.city}
          {"\n"}
          Tel {CONTACT.phone.landline} · Mobile {CONTACT.phone.mobile} ·{" "}
          {CONTACT.email}
        </Text>
      </View>
      <View style={styles.controlBlock}>
        <Text style={styles.controlLabel}>Control No.</Text>
        <Text style={styles.controlNo}>
          {controlNo == null ? "—" : controlNo.toString().padStart(6, "0")}
        </Text>
        {finalisedAt ? (
          <Text style={styles.controlDate}>
            {finalisedAt.toLocaleString("en-PH", {
              year: "numeric",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function PatientBlock({
  patient,
  visit,
}: Pick<ResultDocumentInput, "patient" | "visit">) {
  const age = calculateAge(patient.birthdate);
  const sexLabel =
    patient.sex === "F" ? "Female" : patient.sex === "M" ? "Male" : "—";
  return (
    <View style={styles.patientBlock}>
      <View style={styles.patientCol}>
        <Text style={styles.patientLabel}>Patient</Text>
        <Text style={styles.patientValue}>
          {patient.last_name}, {patient.first_name}
        </Text>
        <Text style={styles.patientSub}>
          {sexLabel}
          {age != null ? ` · ${age} y/o` : ""}
        </Text>
      </View>
      <View style={styles.patientCol}>
        <Text style={styles.patientLabel}>DRM-ID</Text>
        <Text style={styles.patientValue}>{patient.drm_id}</Text>
        <Text style={styles.patientSub}>Visit #{visit.visit_number}</Text>
      </View>
    </View>
  );
}

function SignatureBlock({
  medtech,
}: {
  // The "medtech" field is used for backwards compatibility but represents
  // the staff member who finalised the result — could be a medtech or an
  // xray_technician. The PRC license kind printed below distinguishes
  // them (RMT vs RT).
  medtech: ResultDocumentInput["medtech"];
}) {
  if (!medtech) {
    return (
      <View style={styles.signatureBlock}>
        <View style={styles.signatureCol}>
          <Text style={styles.signatureName}>—</Text>
          <Text style={styles.signatureMeta}>Technologist</Text>
        </View>
      </View>
    );
  }
  return (
    <View style={styles.signatureBlock}>
      <View style={styles.signatureCol}>
        <Text style={styles.signatureName}>{medtech.full_name}</Text>
        <Text style={styles.signatureMeta}>
          {medtech.prc_license_kind ?? "—"}
          {" · PRC License No. "}
          {medtech.prc_license_no ?? "—"}
        </Text>
      </View>
    </View>
  );
}

function PageFooter() {
  return (
    <View style={styles.pageFooter} fixed>
      <Text>{SITE.name} · {CONTACT.address.full}</Text>
      <Text
        render={({ pageNumber, totalPages }) =>
          `Page ${pageNumber} of ${totalPages}`
        }
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Cell rendering helpers
// ---------------------------------------------------------------------------

function displayValue(p: TemplateParam, v: ParamValue | undefined): string {
  if (!v || v.is_blank) return "—";
  if (p.input_type === "numeric") {
    if (v.numeric_value_si != null) return String(v.numeric_value_si);
    if (v.numeric_value_conv != null) return String(v.numeric_value_conv);
    return "—";
  }
  if (p.input_type === "select") return v.select_value ?? "—";
  return v.text_value ?? "—";
}

function displayValueSi(v: ParamValue | undefined): string {
  if (!v || v.is_blank || v.numeric_value_si == null) return "—";
  return String(v.numeric_value_si);
}

function displayValueConv(v: ParamValue | undefined): string {
  if (!v || v.is_blank || v.numeric_value_conv == null) return "—";
  return String(v.numeric_value_conv);
}

// ---------------------------------------------------------------------------
// Layout: simple
// ---------------------------------------------------------------------------

interface BodyContext {
  params: TemplateParam[];
  values: Record<string, ParamValue>;
  ranges: Map<string, EffectiveRange>;
}

function rangeFor(p: TemplateParam, ranges: Map<string, EffectiveRange>): EffectiveRange {
  return (
    ranges.get(p.id) ?? {
      ref_low_si: p.ref_low_si,
      ref_high_si: p.ref_high_si,
      ref_low_conv: p.ref_low_conv,
      ref_high_conv: p.ref_high_conv,
      critical_low_si: null,
      critical_high_si: null,
      band_label: null,
    }
  );
}

function SimpleTable({ params, values, ranges }: BodyContext) {
  return (
    <View style={styles.table}>
      <View style={styles.trHead}>
        <Text style={[styles.thText, { width: `${COLS.simple.test * 100}%` }]}>
          Test
        </Text>
        <Text
          style={[
            styles.thText,
            { width: `${COLS.simple.result * 100}%`, textAlign: "right" },
          ]}
        >
          Result
        </Text>
        <Text
          style={[
            styles.thText,
            { width: `${COLS.simple.flag * 100}%`, textAlign: "center" },
          ]}
        >
          Flag
        </Text>
        <Text style={[styles.thText, { width: `${COLS.simple.unit * 100}%` }]}>
          Unit
        </Text>
        <Text style={[styles.thText, { width: `${COLS.simple.ref * 100}%` }]}>
          Reference
        </Text>
      </View>
      {params.map((p) => {
        if (p.is_section_header) {
          return (
            <View key={p.id} style={styles.sectionHeaderRow}>
              <Text style={styles.sectionHeaderText}>{p.parameter_name}</Text>
            </View>
          );
        }
        const v = values[p.id];
        const flag = v?.flag ?? null;
        const isAbnormal = !!flag;
        const eff = rangeFor(p, ranges);
        return (
          <View key={p.id} style={styles.tr}>
            <Text
              style={[
                styles.td,
                { width: `${COLS.simple.test * 100}%` },
              ]}
            >
              {p.parameter_name}
            </Text>
            <Text
              style={[
                styles.td,
                styles.tdMono,
                ...(isAbnormal ? [styles.tdAbnormal] : []),
                { width: `${COLS.simple.result * 100}%`, textAlign: "right" },
              ]}
            >
              {displayValue(p, v)}
            </Text>
            <Text
              style={[
                styles.td,
                styles.tdBold,
                ...(isAbnormal ? [styles.tdAbnormal] : []),
                { width: `${COLS.simple.flag * 100}%`, textAlign: "center" },
              ]}
            >
              {flag ?? ""}
            </Text>
            <Text
              style={[
                styles.td,
                styles.tdMuted,
                { width: `${COLS.simple.unit * 100}%` },
              ]}
            >
              {p.unit_si ?? ""}
            </Text>
            <Text
              style={[
                styles.td,
                styles.tdMuted,
                { width: `${COLS.simple.ref * 100}%` },
              ]}
            >
              {formatRefRange(eff.ref_low_si, eff.ref_high_si)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Layout: dual_unit (SI + Conventional)
// ---------------------------------------------------------------------------

function DualUnitTable({ params, values, ranges }: BodyContext) {
  return (
    <View style={styles.table}>
      <View style={styles.trHead}>
        <Text
          style={[styles.thText, { width: `${COLS.dualUnit.test * 100}%` }]}
        >
          Test
        </Text>
        <Text
          style={[
            styles.thText,
            {
              width: `${COLS.dualUnit.siResult * 100}%`,
              textAlign: "right",
            },
          ]}
        >
          SI
        </Text>
        <Text
          style={[styles.thText, { width: `${COLS.dualUnit.siUnit * 100}%` }]}
        >
          Unit
        </Text>
        <Text
          style={[styles.thText, { width: `${COLS.dualUnit.siRange * 100}%` }]}
        >
          Range
        </Text>
        <Text
          style={[
            styles.thText,
            {
              width: `${COLS.dualUnit.convResult * 100}%`,
              textAlign: "right",
            },
          ]}
        >
          Conv.
        </Text>
        <Text
          style={[
            styles.thText,
            { width: `${COLS.dualUnit.convUnit * 100}%` },
          ]}
        >
          Unit
        </Text>
        <Text
          style={[
            styles.thText,
            { width: `${COLS.dualUnit.convRange * 100}%` },
          ]}
        >
          Range
        </Text>
      </View>
      {params.map((p) => {
        if (p.is_section_header) {
          return (
            <View key={p.id} style={styles.sectionHeaderRow}>
              <Text style={styles.sectionHeaderText}>{p.parameter_name}</Text>
            </View>
          );
        }
        const v = values[p.id];
        const isAbnormal = !!v?.flag;
        const eff = rangeFor(p, ranges);
        return (
          <View key={p.id} style={styles.tr}>
            <Text
              style={[styles.td, { width: `${COLS.dualUnit.test * 100}%` }]}
            >
              {p.parameter_name}
            </Text>
            <Text
              style={[
                styles.td,
                styles.tdMono,
                ...(isAbnormal ? [styles.tdAbnormal] : []),
                {
                  width: `${COLS.dualUnit.siResult * 100}%`,
                  textAlign: "right",
                },
              ]}
            >
              {displayValueSi(v)}
            </Text>
            <Text
              style={[
                styles.td,
                styles.tdMuted,
                { width: `${COLS.dualUnit.siUnit * 100}%` },
              ]}
            >
              {p.unit_si ?? ""}
            </Text>
            <Text
              style={[
                styles.td,
                styles.tdMuted,
                { width: `${COLS.dualUnit.siRange * 100}%` },
              ]}
            >
              {formatRefRange(eff.ref_low_si, eff.ref_high_si)}
            </Text>
            <Text
              style={[
                styles.td,
                styles.tdMono,
                ...(isAbnormal ? [styles.tdAbnormal] : []),
                {
                  width: `${COLS.dualUnit.convResult * 100}%`,
                  textAlign: "right",
                },
              ]}
            >
              {displayValueConv(v)}
            </Text>
            <Text
              style={[
                styles.td,
                styles.tdMuted,
                { width: `${COLS.dualUnit.convUnit * 100}%` },
              ]}
            >
              {p.unit_conv ?? ""}
            </Text>
            <Text
              style={[
                styles.td,
                styles.tdMuted,
                { width: `${COLS.dualUnit.convRange * 100}%` },
              ]}
            >
              {formatRefRange(eff.ref_low_conv, eff.ref_high_conv)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Layout: multi_section
// ---------------------------------------------------------------------------

function MultiSectionBody({ params, values, ranges }: BodyContext) {
  // Group params by section. Section-header rows act as the heading; data rows
  // following them belong to that section. Rows with no section ride along at
  // the end (e.g. the "Remarks" row in the urinalysis seed).
  type Group = { title: string | null; rows: TemplateParam[] };
  const groups: Group[] = [];
  let current: Group | null = null;
  for (const p of params) {
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
    <>
      {groups.map((g, idx) => (
        <View key={idx} style={styles.multiSection}>
          {g.title ? (
            <Text style={styles.multiSectionTitle}>{g.title}</Text>
          ) : null}
          <View style={styles.table}>
            {g.rows.map((p) => {
              const v = values[p.id];
              const isAbnormal = !!v?.flag;
              const eff = rangeFor(p, ranges);
              return (
                <View key={p.id} style={styles.tr}>
                  <Text
                    style={[
                      styles.td,
                      { width: `${COLS.multi.test * 100}%` },
                    ]}
                  >
                    {p.parameter_name}
                  </Text>
                  <Text
                    style={[
                      styles.td,
                      styles.tdMono,
                      ...(isAbnormal ? [styles.tdAbnormal] : []),
                      {
                        width: `${COLS.multi.result * 100}%`,
                        textAlign: "right",
                      },
                    ]}
                  >
                    {displayValue(p, v)}
                  </Text>
                  <Text
                    style={[
                      styles.td,
                      styles.tdBold,
                      ...(isAbnormal ? [styles.tdAbnormal] : []),
                      {
                        width: `${COLS.multi.flag * 100}%`,
                        textAlign: "center",
                      },
                    ]}
                  >
                    {v?.flag ?? ""}
                  </Text>
                  <Text
                    style={[
                      styles.td,
                      styles.tdMuted,
                      { width: `${COLS.multi.unit * 100}%` },
                    ]}
                  >
                    {p.unit_si ?? ""}
                  </Text>
                  <Text
                    style={[
                      styles.td,
                      styles.tdMuted,
                      { width: `${COLS.multi.ref * 100}%` },
                    ]}
                  >
                    {formatRefRange(eff.ref_low_si, eff.ref_high_si)}
                  </Text>
                </View>
              );
            })}
          </View>
        </View>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Layout: imaging_report (free-text Findings + Impression)
// ---------------------------------------------------------------------------

function ImagingBody({
  params,
  values,
  imageAttachment,
}: Omit<BodyContext, "ranges"> & {
  imageAttachment?: ResultDocumentInput["imageAttachment"];
}) {
  // Imaging templates have ~2 free-text params: Findings and Impression. We
  // render whatever params the admin defined, in sort order, as labelled
  // monospace blocks. Blank values render as "—" so the sections never
  // collapse silently.
  //
  // When an image attachment is present, render it AFTER the text blocks.
  // - image/jpeg | image/png | image/webp → embedded via <Image>. We hand
  //   @react-pdf/renderer a Buffer so it can detect the format itself; both
  //   PNG and JPEG are natively supported. WebP support varies by version
  //   but works in 4.x with a Buffer src.
  // - application/pdf → not embeddable (out of scope), so we render a short
  //   note pointing at the separate file.
  const attachmentMime = imageAttachment?.mime ?? null;
  const isImage = attachmentMime != null && attachmentMime.startsWith("image/");
  const isPdf = attachmentMime === "application/pdf";

  return (
    <View style={styles.imagingBody}>
      {params.map((p) => {
        if (p.is_section_header) return null;
        const v = values[p.id];
        const text = v?.text_value?.trim();
        return (
          <View key={p.id} wrap={false}>
            <Text style={styles.imagingHeading}>{p.parameter_name}</Text>
            <Text style={styles.imagingText}>{text || "—"}</Text>
          </View>
        );
      })}
      {imageAttachment ? (
        <View style={styles.imagingAttachmentBlock} wrap={false}>
          <Text style={styles.imagingHeading}>Attached Image</Text>
          {isImage ? (
            // @react-pdf/renderer's <Image> component is a PDF primitive,
            // not an HTML <img>; no alt prop is supported.
            // eslint-disable-next-line jsx-a11y/alt-text
            <Image
              src={Buffer.from(imageAttachment.data)}
              style={styles.imagingAttachmentImage}
            />
          ) : null}
          {isPdf ? (
            <Text style={styles.imagingAttachmentNote}>
              Attachment: {imageAttachment.filename} — see separate PDF.
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Top-level document
// ---------------------------------------------------------------------------

export function ResultDocument(input: ResultDocumentInput) {
  const visibleParams = filterParamsForPatient(input.params, input.patient.sex);
  const ageMonths = calculateAgeMonths(input.patient.birthdate);
  const ranges = new Map<string, EffectiveRange>();
  for (const p of visibleParams) {
    if (!p.is_section_header) {
      ranges.set(p.id, pickRangeForPatient(p, input.patient.sex, ageMonths));
    }
  }

  return (
    <Document
      title={`${input.service.name} — ${input.patient.last_name}, ${input.patient.first_name}`}
      author={SITE.name}
    >
      <Page size="A4" style={styles.page}>
        {input.isPreview ? (
          <Text style={styles.watermark} fixed>
            PREVIEW
          </Text>
        ) : null}

        <Letterhead
          controlNo={input.controlNo}
          finalisedAt={input.finalisedAt}
        />
        <PatientBlock patient={input.patient} visit={input.visit} />

        <Text style={styles.testTitle}>{input.service.name}</Text>
        <Text style={styles.testCode}>{input.service.code}</Text>
        {input.template.header_notes ? (
          <Text style={styles.headerNotes}>{input.template.header_notes}</Text>
        ) : null}

        {input.template.layout === "simple" ? (
          <SimpleTable params={visibleParams} values={input.values} ranges={ranges} />
        ) : null}
        {input.template.layout === "dual_unit" ? (
          <DualUnitTable params={visibleParams} values={input.values} ranges={ranges} />
        ) : null}
        {input.template.layout === "multi_section" ? (
          <MultiSectionBody params={visibleParams} values={input.values} ranges={ranges} />
        ) : null}
        {input.template.layout === "imaging_report" ? (
          <ImagingBody
            params={visibleParams}
            values={input.values}
            imageAttachment={input.imageAttachment}
          />
        ) : null}

        {input.template.footer_notes ? (
          <Text style={styles.footerNotes}>{input.template.footer_notes}</Text>
        ) : null}

        <SignatureBlock medtech={input.medtech} />
        <PageFooter />
      </Page>
    </Document>
  );
}
