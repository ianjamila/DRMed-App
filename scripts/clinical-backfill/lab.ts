import { run } from "./engine";
import type { TabConfig } from "./lib/types";

// LAB SERVICE column map (1-based) — verified from scripts/history-import/lab-services.ts.
const cfg: TabConfig = {
  tab: "LAB SERVICE", sheetName: "LAB SERVICE", isConsult: false,
  cols: {
    posting_date: 1, control_no: 2, test_no: 3, patient_name: 4, hmo_flag: 5,
    hmo_provider: 6, service: 8, base: 9, final: 14, mop: 15, or_number: 25, date_paid: 26,
  },
};
run(cfg).catch((e) => { console.error("FATAL:", e); process.exit(1); });
