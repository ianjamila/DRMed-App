import { describe, expect, it } from "vitest";
import {
  orderByLastVisit,
  PATIENTS_WITHOUT_CONSENT_CSV_HEADER,
  patientsWithoutConsentCsvFilename,
  patientsWithoutConsentCsvHref,
  patientsWithoutConsentCsvRows,
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

describe("href / filename", () => {
  it("has no filters and stamps the day", () => {
    expect(patientsWithoutConsentCsvHref()).toBe("/api/admin/reports/patients-without-consent.csv");
    expect(patientsWithoutConsentCsvFilename("2026-09-08")).toBe("patients-without-consent-2026-09-08.csv");
  });
});
