import { humaniseCode } from "@/lib/format/humanise-code";

export const SCHEDULE_LABEL: Record<string, string> = {
  fixed_5day_mon_fri: "Mon–Fri (5d)",
  fixed_6day_mon_sat: "Mon–Sat (6d)",
  shifting_5of6_mon_sat: "Shifting 5/6",
};

export const PAYMENT_LABEL: Record<string, string> = {
  cash: "Cash",
  bank: "Bank",
};

export const ROLE_LABEL: Record<string, string> = {
  admin: "Admin",
  reception: "Reception",
  medtech: "Medtech",
  pathologist: "Pathologist",
  xray_tech: "X-ray tech",
  physician: "Physician",
};

// payroll_runs.status. The runs list and the run review page both show it as a
// pill, and the review page names it in the "Re-import DTR?" dialog.
export const RUN_STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  computed: "Computed",
  finalised: "Finalised",
  voided: "Voided",
};

export const RUN_STATUS_BADGE: Record<string, string> = {
  draft: "bg-slate-200 text-slate-700",
  computed: "bg-amber-100 text-amber-900",
  finalised: "bg-emerald-100 text-emerald-900",
  voided: "bg-rose-100 text-rose-900",
};

export function runStatusLabel(status: string): string {
  return RUN_STATUS_LABEL[status] ?? humaniseCode(status);
}
