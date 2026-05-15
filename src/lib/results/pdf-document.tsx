// Server-only React component that renders a Phase 13 result PDF using
// @react-pdf/renderer. The same document is used for medtech finalisation
// AND for the admin preview route — passing `isPreview: true` adds a faint
// "PREVIEW" watermark and replaces the control number / signature block.
//
// Keep all styling self-contained here. @react-pdf/renderer uses StyleSheet,
// not Tailwind, so the brand palette is duplicated as plain hex values.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Document,
  Page,
  View,
  Text,
  Image,
  StyleSheet,
} from "@react-pdf/renderer";
import { SITE } from "@/lib/marketing/site";
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

// Read the logo bytes once at module load. The file is small (~400KB) and
// this runs on the Node server, so it's safe in Server Components / Server
// Actions. If a deployment target ever blocks fs access we can switch to a
// base64-encoded inline string, but for Vercel this is fine.
const LOGO_BYTES = readFileSync(join(process.cwd(), "public", "logo.png"));

const C = {
  navy: "#284570",
  ink: "#111827",
  inkSoft: "#374151",
  inkMuted: "#6b7280",
  border: "#e3eef9",
  borderStrong: "#cbd5e1",
  bgSoft: "#f0f6fc",
  flag: "#b91c1c",
  watermark: "#cbd5e1",
  rule: "#9aa6b8",
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

  // ── Letterhead ─────────────────────────────────────────────────────────
  letterhead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingBottom: 4,
  },
  logo: {
    width: 140,
    height: 54,
    objectFit: "contain",
  },
  addressBlock: {
    alignItems: "flex-end",
    maxWidth: 240,
  },
  addressLine: {
    fontSize: 9,
    color: C.inkMuted,
    fontFamily: "Helvetica-Bold",
    textAlign: "right",
    lineHeight: 1.4,
    letterSpacing: 0.3,
  },

  // ── Patient info grid ─────────────────────────────────────────────────
  patientGrid: {
    marginTop: 10,
    flexDirection: "column",
  },
  patientRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 3,
  },
  patientCell: {
    flexDirection: "row",
    alignItems: "baseline",
  },
  patientLabel: {
    fontFamily: "Helvetica-Bold",
    fontSize: 9,
    color: C.ink,
    textTransform: "uppercase",
    letterSpacing: 0.3,
    marginRight: 4,
  },
  patientValue: {
    fontSize: 9.5,
    color: C.ink,
    fontFamily: "Helvetica",
  },
  patientSubline: {
    fontSize: 8,
    color: C.inkMuted,
    marginTop: 1,
  },
  hr: {
    marginTop: 6,
    borderBottomWidth: 1,
    borderBottomColor: C.rule,
  },
  navyRule: {
    borderBottomWidth: 1,
    borderBottomColor: C.navy,
  },

  // ── Section title band ────────────────────────────────────────────────
  sectionTitleBand: {
    paddingVertical: 6,
    alignItems: "center",
  },
  testTitle: {
    textAlign: "center",
    fontSize: 15,
    fontFamily: "Helvetica-Bold",
    color: C.navy,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  testCode: {
    marginTop: 2,
    textAlign: "center",
    fontSize: 8,
    color: C.inkMuted,
    fontFamily: "Helvetica",
    letterSpacing: 0.4,
  },
  headerNotes: {
    marginTop: 6,
    fontSize: 8.5,
    color: C.inkSoft,
    fontStyle: "italic",
    textAlign: "center",
  },

  // ── Tables ────────────────────────────────────────────────────────────
  table: {
    marginTop: 10,
  },
  tr: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    minHeight: 20,
    alignItems: "center",
  },
  trHead: {
    flexDirection: "row",
    backgroundColor: C.navy,
    minHeight: 22,
    alignItems: "center",
  },
  trSubHead: {
    flexDirection: "row",
    backgroundColor: C.navy,
    minHeight: 18,
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: "#ffffff",
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
    paddingVertical: 7,
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
  flagBadge: {
    paddingHorizontal: 4,
    paddingVertical: 1,
    fontSize: 8,
    fontFamily: "Helvetica-Bold",
    color: C.flag,
    textAlign: "center",
    textTransform: "uppercase",
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

  // ── Remarks block ─────────────────────────────────────────────────────
  remarksBlock: {
    marginTop: 16,
  },
  remarksLabel: {
    fontFamily: "Helvetica-Bold",
    fontSize: 9.5,
    color: C.navy,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  remarksBody: {
    marginTop: 4,
    fontSize: 9,
    color: C.inkSoft,
    fontStyle: "italic",
    minHeight: 24,
  },

  // ── Signature block ───────────────────────────────────────────────────
  signatureBlock: {
    marginTop: 36,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  signatureCol: {
    flex: 1,
    alignItems: "center",
    paddingHorizontal: 4,
  },
  signatureNameRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "center",
    width: "100%",
    minHeight: 16,
  },
  signatureName: {
    fontFamily: "Helvetica-Bold",
    fontSize: 9.5,
    color: C.ink,
    textTransform: "uppercase",
    letterSpacing: 0.3,
    textAlign: "center",
  },
  signatureUnderline: {
    marginTop: 2,
    width: "85%",
    borderBottomWidth: 1,
    borderBottomColor: C.borderStrong,
  },
  signatureRole: {
    marginTop: 3,
    fontFamily: "Helvetica-Bold",
    fontSize: 9,
    color: C.ink,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    textAlign: "center",
  },
  signatureLicense: {
    marginTop: 1,
    fontSize: 8,
    color: C.inkSoft,
    textAlign: "center",
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
    siFlag: 0.06,
    siUnit: 0.1,
    siRange: 0.14,
    convResult: 0.12,
    convFlag: 0.06,
    convUnit: 0.1,
    convRange: 0.12,
  },
  multi: { test: 0.42, result: 0.18, flag: 0.08, unit: 0.12, ref: 0.2 },
} as const;

// ---------------------------------------------------------------------------
// Date formatting helpers
// ---------------------------------------------------------------------------

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

// Format a JS Date as DD-MMM-YYYY in Asia/Manila — matches the reference's
// "15-May-2026" / "21-Nov-1951" styling.
function formatDateManila(d: Date | null): string {
  if (!d) return "";
  // Use Intl to derive Manila Y/M/D then assemble in our own format.
  const fmt = new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value ?? "";
  const m = parts.find((p) => p.type === "month")?.value ?? "";
  const day = parts.find((p) => p.type === "day")?.value ?? "";
  const monthIdx = Math.max(0, Math.min(11, Number(m) - 1));
  return `${day}-${MONTHS[monthIdx]}-${y}`;
}

// Format an ISO date string (e.g. patient.birthdate "1985-04-12") as
// DD-MMM-YYYY without applying timezone shifts that could change the day.
function formatIsoDate(iso: string | null): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return "";
  const [, yy, mm, dd] = m;
  const idx = Math.max(0, Math.min(11, Number(mm) - 1));
  return `${dd}-${MONTHS[idx]}-${yy}`;
}

// ---------------------------------------------------------------------------
// Header / footer building blocks (shared across layouts)
// ---------------------------------------------------------------------------

function Letterhead() {
  return (
    <View style={styles.letterhead}>
      {/* eslint-disable-next-line jsx-a11y/alt-text */}
      <Image src={LOGO_BYTES} style={styles.logo} />
      <View style={styles.addressBlock}>
        <Text style={styles.addressLine}>4/F NORTHRIDGE PLAZA,</Text>
        <Text style={styles.addressLine}>CONGRESSIONAL AVE., QUEZON CITY</Text>
        <Text style={styles.addressLine}>(02) 8355 3517 / (0916) 604 3208</Text>
      </View>
    </View>
  );
}

function PatientInfoGrid({
  patient,
  visit,
  controlNo,
  finalisedAt,
}: Pick<ResultDocumentInput, "patient" | "visit" | "controlNo" | "finalisedAt">) {
  const age = calculateAge(patient.birthdate);
  const sexLabel =
    patient.sex === "F" ? "FEMALE" : patient.sex === "M" ? "MALE" : "—";
  const fullName = `${patient.last_name}, ${patient.first_name}`.toUpperCase();
  const controlDisplay =
    controlNo == null ? "—" : controlNo.toString();
  const dateDisplay = formatDateManila(finalisedAt);
  const birthdayDisplay = formatIsoDate(patient.birthdate);

  // Some fields (CONTACT #, PHYSICIAN, SENIOR/PWD ID) aren't wired up in the
  // ResultDocumentInput type yet — we render the label with an empty value,
  // matching the reference's "CONTACT #:" empty case.
  return (
    <View style={styles.patientGrid}>
      <View style={styles.patientRow}>
        <View style={[styles.patientCell, { width: "50%" }]}>
          <Text style={styles.patientLabel}>CONTROL NO:</Text>
          <Text style={styles.patientValue}>{controlDisplay}</Text>
        </View>
        <View style={[styles.patientCell, { width: "50%" }]}>
          <Text style={styles.patientLabel}>DATE:</Text>
          <Text style={styles.patientValue}>{dateDisplay}</Text>
        </View>
      </View>
      <View style={styles.patientRow}>
        <View style={[styles.patientCell, { width: "100%" }]}>
          <Text style={styles.patientLabel}>PATIENT NAME:</Text>
          <Text style={styles.patientValue}>{fullName}</Text>
        </View>
      </View>
      <View style={{ flexDirection: "row" }}>
        <Text style={styles.patientSubline}>
          {patient.drm_id} · Visit #{visit.visit_number}
        </Text>
      </View>
      <View style={styles.patientRow}>
        <View style={[styles.patientCell, { width: "34%" }]}>
          <Text style={styles.patientLabel}>BIRTHDAY:</Text>
          <Text style={styles.patientValue}>{birthdayDisplay}</Text>
        </View>
        <View style={[styles.patientCell, { width: "33%" }]}>
          <Text style={styles.patientLabel}>GENDER:</Text>
          <Text style={styles.patientValue}>{sexLabel}</Text>
        </View>
        <View style={[styles.patientCell, { width: "33%" }]}>
          <Text style={styles.patientLabel}>CONTACT #:</Text>
          <Text style={styles.patientValue}></Text>
        </View>
      </View>
      <View style={styles.patientRow}>
        <View style={[styles.patientCell, { width: "34%" }]}>
          <Text style={styles.patientLabel}>PHYSICIAN:</Text>
          <Text style={styles.patientValue}></Text>
        </View>
        <View style={[styles.patientCell, { width: "33%" }]}>
          <Text style={styles.patientLabel}>AGE:</Text>
          <Text style={styles.patientValue}>{age != null ? String(age) : ""}</Text>
        </View>
        <View style={[styles.patientCell, { width: "33%" }]}>
          <Text style={styles.patientLabel}>SENIOR / PWD ID:</Text>
          <Text style={styles.patientValue}></Text>
        </View>
      </View>
    </View>
  );
}

function SectionTitle({
  service,
}: {
  service: ResultDocumentInput["service"];
}) {
  return (
    <View>
      <View style={[styles.hr, styles.navyRule]} />
      <View style={styles.sectionTitleBand}>
        <Text style={styles.testTitle}>{service.name.toUpperCase()}</Text>
        <Text style={styles.testCode}>{service.code}</Text>
      </View>
      <View style={[styles.hr, styles.navyRule, { marginTop: 0 }]} />
    </View>
  );
}

function SignatureColumn({
  name,
  role,
  license,
}: {
  name: string;
  role: string;
  license: string;
}) {
  return (
    <View style={styles.signatureCol}>
      <View style={styles.signatureNameRow}>
        <Text style={styles.signatureName}>{name}</Text>
      </View>
      <View style={styles.signatureUnderline} />
      <Text style={styles.signatureRole}>{role}</Text>
      <Text style={styles.signatureLicense}>{license}</Text>
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
  // Pathologist and QC are visual placeholders until those sign-off roles
  // ship. The medtech column comes from real data.
  const medtechName = medtech?.full_name ?? "—";
  const medtechLicense = medtech
    ? `PRC License No. ${medtech.prc_license_no ?? "—"}`
    : "PRC License No. —";
  return (
    <View style={styles.signatureBlock}>
      <SignatureColumn
        name="—"
        role="Pathologist"
        license="PRC License No. —"
      />
      <SignatureColumn
        name={medtechName}
        role="Medical Technologist"
        license={medtechLicense}
      />
      <SignatureColumn
        name="—"
        role="Quality Control"
        license="PRC License No. —"
      />
    </View>
  );
}

function PageFooter() {
  return (
    <View style={styles.pageFooter} fixed>
      <Text>{SITE.name}</Text>
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
            <View
              style={{
                width: `${COLS.simple.flag * 100}%`,
                alignItems: "center",
              }}
            >
              {flag ? (
                <Text style={styles.flagBadge}>{flag}</Text>
              ) : (
                <Text> </Text>
              )}
            </View>
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
// Layout: dual_unit (SI + Conventional) with parent column header band
// ---------------------------------------------------------------------------

function DualUnitTable({ params, values, ranges }: BodyContext) {
  const siGroupWidth =
    COLS.dualUnit.siResult +
    COLS.dualUnit.siFlag +
    COLS.dualUnit.siUnit +
    COLS.dualUnit.siRange;
  const convGroupWidth =
    COLS.dualUnit.convResult +
    COLS.dualUnit.convFlag +
    COLS.dualUnit.convUnit +
    COLS.dualUnit.convRange;
  return (
    <View style={styles.table}>
      {/* Parent column header band: TEST | SYSTEM INTERNATIONAL | CONVENTIONAL */}
      <View style={styles.trHead}>
        <Text
          style={[
            styles.thText,
            {
              width: `${COLS.dualUnit.test * 100}%`,
              textAlign: "center",
            },
          ]}
        >
          Test
        </Text>
        <Text
          style={[
            styles.thText,
            {
              width: `${siGroupWidth * 100}%`,
              textAlign: "center",
            },
          ]}
        >
          System International
        </Text>
        <Text
          style={[
            styles.thText,
            {
              width: `${convGroupWidth * 100}%`,
              textAlign: "center",
            },
          ]}
        >
          Conventional
        </Text>
      </View>
      {/* Sub-column header row */}
      <View style={styles.trSubHead}>
        <Text
          style={[styles.thText, { width: `${COLS.dualUnit.test * 100}%` }]}
        >
          {" "}
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
          Result
        </Text>
        <Text
          style={[
            styles.thText,
            { width: `${COLS.dualUnit.siFlag * 100}%`, textAlign: "center" },
          ]}
        >
          Flag
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
          Result
        </Text>
        <Text
          style={[
            styles.thText,
            { width: `${COLS.dualUnit.convFlag * 100}%`, textAlign: "center" },
          ]}
        >
          Flag
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
        const flag = v?.flag ?? null;
        const isAbnormal = !!flag;
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
            <View
              style={{
                width: `${COLS.dualUnit.siFlag * 100}%`,
                alignItems: "center",
              }}
            >
              {flag ? (
                <Text style={styles.flagBadge}>{flag}</Text>
              ) : (
                <Text> </Text>
              )}
            </View>
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
            <View
              style={{
                width: `${COLS.dualUnit.convFlag * 100}%`,
                alignItems: "center",
              }}
            >
              {flag ? (
                <Text style={styles.flagBadge}>{flag}</Text>
              ) : (
                <Text> </Text>
              )}
            </View>
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
              const flag = v?.flag ?? null;
              const isAbnormal = !!flag;
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
                  <View
                    style={{
                      width: `${COLS.multi.flag * 100}%`,
                      alignItems: "center",
                    }}
                  >
                    {flag ? (
                      <Text style={styles.flagBadge}>{flag}</Text>
                    ) : (
                      <Text> </Text>
                    )}
                  </View>
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
// Remarks block (sits between body and signatures)
// ---------------------------------------------------------------------------

function RemarksBlock({ notes }: { notes: string | null }) {
  return (
    <View style={styles.remarksBlock} wrap={false}>
      <Text style={styles.remarksLabel}>REMARKS</Text>
      <Text style={styles.remarksBody}>{notes?.trim() ?? ""}</Text>
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

        <Letterhead />
        <PatientInfoGrid
          patient={input.patient}
          visit={input.visit}
          controlNo={input.controlNo}
          finalisedAt={input.finalisedAt}
        />

        <SectionTitle service={input.service} />

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

        <RemarksBlock notes={input.template.footer_notes} />

        <SignatureBlock medtech={input.medtech} />
        <PageFooter />
      </Page>
    </Document>
  );
}
