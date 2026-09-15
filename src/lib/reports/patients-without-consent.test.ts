import { describe, expect, it } from "vitest";
import type { SortSpec } from "@/lib/ui/table-params";
import {
  comparePatientsWithoutConsent,
  orderByLastVisit,
  PATIENTS_WITHOUT_CONSENT_CSV_HEADER,
  PATIENTS_WITHOUT_CONSENT_DEFAULT_SORT,
  patientsWithoutConsentCsvFilename,
  patientsWithoutConsentCsvHref,
  patientsWithoutConsentCsvRows,
  type PatientsWithoutConsentSortColumn,
  type PatientWithoutConsentRow,
} from "./patients-without-consent";

const rows: PatientWithoutConsentRow[] = [
  { id: "p1", drm_id: "DRM-1", first_name: "Ana", last_name: "Cruz", phone: "0917", email: null, pre_registered: true },
  { id: "p2", drm_id: "DRM-2", first_name: null, last_name: null, phone: null, email: "b@x.ph", pre_registered: false },
  { id: "p3", drm_id: "DRM-3", first_name: "Cy", last_name: "Dee", phone: null, email: null, pre_registered: false },
];
const visitCount = new Map([["p1", 2], ["p3", 1]]);
const lastVisit = new Map([["p1", "2026-08-01"], ["p3", "2026-09-01"]]);

describe("orderByLastVisit", () => {
  it("most recently active first, never-visited last, stable otherwise", () => {
    expect(orderByLastVisit(rows, lastVisit).map((r) => r.id)).toEqual(["p3", "p1", "p2"]);
  });

  it("keeps patients with no visits in their original order", () => {
    expect(orderByLastVisit(rows, new Map()).map((r) => r.id)).toEqual(["p1", "p2", "p3"]);
  });
});

describe("patientsWithoutConsentCsvRows", () => {
  it("mirrors the table and adds the contact details for the campaign list", () => {
    const out = patientsWithoutConsentCsvRows(orderByLastVisit(rows, lastVisit), visitCount, lastVisit);
    expect(out[0]).toEqual([...PATIENTS_WITHOUT_CONSENT_CSV_HEADER]);
    expect(out[1]).toEqual(["Dee, Cy", "DRM-3", "no", 1, "2026-09-01", "", ""]);
    expect(out[2]).toEqual(["Cruz, Ana", "DRM-1", "yes", 2, "2026-08-01", "0917", ""]);
    expect(out[3]).toEqual(["(no name on file)", "DRM-2", "no", 0, "", "", "b@x.ph"]);
  });
});

describe("M15: display-limit trims only after sorting by last visit", () => {
  // Regression guard for the real bug: a patient who registered long ago but
  // visited recently must survive a display trim over one who registered
  // recently but never returned — the trim has to happen on the SORTED list,
  // never before it.
  const oldPatientRecentVisit: PatientWithoutConsentRow = {
    id: "old",
    drm_id: "DRM-OLD",
    first_name: "Old",
    last_name: "Timer",
    phone: null,
    email: null,
    pre_registered: false,
  };
  const newPatientNoVisit: PatientWithoutConsentRow = {
    id: "new",
    drm_id: "DRM-NEW",
    first_name: "New",
    last_name: "Comer",
    phone: null,
    email: null,
    pre_registered: false,
  };
  // Registration order (what a naive created_at-desc truncation would use)
  // deliberately disagrees with visit recency: newPatientNoVisit is "first"
  // by registration, oldPatientRecentVisit is first by actual activity.
  const registrationOrder = [newPatientNoVisit, oldPatientRecentVisit];
  const recentVisit = new Map([["old", "2026-09-10"]]);

  it("orderByLastVisit alone already puts the recently-active patient first", () => {
    expect(orderByLastVisit(registrationOrder, recentVisit).map((r) => r.id)).toEqual([
      "old",
      "new",
    ]);
  });

  it("a trim to 1 keeps the recently-active patient, not the recently-registered one", () => {
    const sorted = orderByLastVisit(registrationOrder, recentVisit);
    const trimmed = sorted.slice(0, 1);
    expect(trimmed.map((r) => r.id)).toEqual(["old"]);
  });
});

describe("comparePatientsWithoutConsent", () => {
  const sort = (
    key: PatientsWithoutConsentSortColumn,
    dir: "asc" | "desc",
  ): SortSpec<PatientsWithoutConsentSortColumn> => ({ key, dir });

  it("default sort (last_visit desc) matches orderByLastVisit, including the null-last rule", () => {
    // Same fixture as the `orderByLastVisit` suite above — the comparator's
    // `last_visit` case is a drop-in replacement, so both must agree.
    const byComparator = [...rows].sort((a, b) =>
      comparePatientsWithoutConsent(a, b, PATIENTS_WITHOUT_CONSENT_DEFAULT_SORT, visitCount, lastVisit),
    );
    expect(byComparator.map((r) => r.id)).toEqual(
      orderByLastVisit(rows, lastVisit).map((r) => r.id),
    );
  });

  it("last_visit: never-visited patients sink to the bottom in ASCENDING order too", () => {
    const ascending = [...rows].sort((a, b) =>
      comparePatientsWithoutConsent(a, b, sort("last_visit", "asc"), visitCount, lastVisit),
    );
    // p2 has no visit at all and must stay last even though ascending would
    // otherwise put its "" stand-in value first.
    expect(ascending.at(-1)?.id).toBe("p2");
  });

  it("patient: sorts by formatted name and sinks a blank name to the bottom in either direction", () => {
    const asc = [...rows].sort((a, b) =>
      comparePatientsWithoutConsent(a, b, sort("patient", "asc"), visitCount, lastVisit),
    );
    expect(asc.map((r) => r.id)).toEqual(["p1", "p3", "p2"]); // Cruz, Ana < Dee, Cy; p2 has no name on file

    const desc = [...rows].sort((a, b) =>
      comparePatientsWithoutConsent(a, b, sort("patient", "desc"), visitCount, lastVisit),
    );
    expect(desc.map((r) => r.id)).toEqual(["p3", "p1", "p2"]); // still last, not first
  });

  it("drm_id: plain text ordering", () => {
    const desc = [...rows].sort((a, b) =>
      comparePatientsWithoutConsent(a, b, sort("drm_id", "desc"), visitCount, lastVisit),
    );
    expect(desc.map((r) => r.id)).toEqual(["p3", "p2", "p1"]);
  });

  it("visits: numeric, missing counts default to 0", () => {
    const desc = [...rows].sort((a, b) =>
      comparePatientsWithoutConsent(a, b, sort("visits", "desc"), visitCount, lastVisit),
    );
    expect(desc.map((r) => r.id)).toEqual(["p1", "p3", "p2"]); // 2, 1, 0
  });

  it("contact: both on file outranks one, which outranks none, regardless of alphabetical order", () => {
    const both: PatientWithoutConsentRow = {
      id: "both",
      drm_id: "DRM-BOTH",
      first_name: "Both",
      last_name: "Contactable",
      phone: "0917",
      email: "both@x.ph",
      pre_registered: false,
    };
    const none: PatientWithoutConsentRow = {
      id: "none",
      drm_id: "DRM-NONE",
      first_name: "No",
      last_name: "Contact",
      phone: null,
      email: null,
      pre_registered: false,
    };
    const fixture = [none, ...rows, both]; // p1: phone only, p2: email only
    const desc = [...fixture].sort((a, b) =>
      comparePatientsWithoutConsent(a, b, sort("contact", "desc"), visitCount, lastVisit),
    );
    // Ties break on ascending id, independent of the requested direction:
    // {p1, p2} at score 1, then {none, p3} at score 0.
    expect(desc.map((r) => r.id)).toEqual(["both", "p1", "p2", "none", "p3"]);
  });

  it("ends every tie in an ascending id tie-break", () => {
    // p1 and p2 both have a contact score of 1 (one channel each).
    const desc = [...rows].sort((a, b) =>
      comparePatientsWithoutConsent(a, b, sort("contact", "desc"), visitCount, lastVisit),
    );
    expect(desc.slice(0, 2).map((r) => r.id)).toEqual(["p1", "p2"]);
  });
});

describe("href / filename", () => {
  it("has no filters and stamps the day", () => {
    expect(patientsWithoutConsentCsvHref()).toBe("/api/admin/reports/patients-without-consent.csv");
    expect(patientsWithoutConsentCsvFilename("2026-09-08")).toBe("patients-without-consent-2026-09-08.csv");
  });
});
