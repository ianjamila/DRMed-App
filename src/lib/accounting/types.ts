import "server-only";

// Three Google Sheets tabs the accountant maintains. Keys also serve as the
// `sync_state.key` values written by the cron watermark.
export const TAB_KEYS = ["lab_services", "doctor_consultations", "doctor_procedures"] as const;
export type TabKey = (typeof TAB_KEYS)[number];

export type SheetCellValue = string | number | null;
export type SheetRow = SheetCellValue[];

export interface TabConfig {
  key: TabKey;
  envTabName: string;
  // Human label, used in the admin UI and audit logs.
  label: string;
  // Watermark column on `sync_state.last_synced_at` advances based on which
  // timestamp drives row eligibility. Lab uses released_at; doctor flows use
  // visit.created_at because consultations and procedures complete in real time
  // (no separate release step).
  watermarkSource: "released_at" | "visit_created_at";
}

export interface TabSyncResult {
  key: TabKey;
  label: string;
  rowsAppended: number;
  watermarkBefore: string;
  watermarkAfter: string;
  // Set when the tab was skipped (e.g. envs missing). Sync continues on the
  // remaining tabs so a single misconfiguration doesn't break everything.
  skippedReason?: string;
}

export interface SyncResult {
  startedAt: string;
  finishedAt: string;
  tabs: TabSyncResult[];
  totalRowsAppended: number;
}

export interface AccountingEnv {
  serviceAccountJson: string;
  sheetId: string;
  tabLab: string;
  tabConsult: string;
  tabProcedure: string;
}
