import { describe, expect, it, vi } from "vitest";
import { CURRENT_CONSENT_NOTICE_VERSION } from "./notice";
import {
  recordSelfRegistrationGrant,
  selfRegistrationGrant,
  shouldRecordBookingConsent,
} from "./self-registration";

describe("shouldRecordBookingConsent", () => {
  it("records for a brand-new patient who ticked the agreement", () => {
    expect(shouldRecordBookingConsent("created", true)).toBe(true);
  });

  it.each(["reused", "existing", "walk_in"] as const)(
    "never re-affirms consent for a %s patient from a public form",
    (resolution) => {
      expect(shouldRecordBookingConsent(resolution, true)).toBe(false);
    },
  );

  it("never records without the tick, even for a new patient", () => {
    expect(shouldRecordBookingConsent("created", false)).toBe(false);
  });
});

describe("selfRegistrationGrant", () => {
  const row = selfRegistrationGrant({
    patientId: "p-1",
    ip: "203.0.113.9",
    userAgent: "vitest",
  });

  it("is a patient-actor 'granted' event with the current notice version", () => {
    expect(row).toEqual({
      patient_id: "p-1",
      event_type: "granted",
      method: "self_registration",
      notice_version: CURRENT_CONSENT_NOTICE_VERSION,
      signatory: "self",
      actor_kind: "patient",
      ip: "203.0.113.9",
      user_agent: "vitest",
    });
  });

  it("never sets created_by — no staff member vouched for a self-service grant", () => {
    expect("created_by" in row).toBe(false);
  });

  it("passes null ip/agent through unchanged", () => {
    const anon = selfRegistrationGrant({ patientId: "p-2", ip: null, userAgent: null });
    expect(anon.ip).toBeNull();
    expect(anon.user_agent).toBeNull();
  });
});

describe("recordSelfRegistrationGrant", () => {
  const input = { patientId: "p-1", ip: "203.0.113.9", userAgent: "vitest" };

  it("inserts the self-registration grant row and reports it recorded", async () => {
    const inserted: unknown[] = [];
    const reportFailure = vi.fn();
    const recorded = await recordSelfRegistrationGrant(
      {
        insertGrant: async (row) => {
          inserted.push(row);
          return { error: null };
        },
        reportFailure,
      },
      input,
    );

    expect(recorded).toBe(true);
    expect(inserted).toEqual([selfRegistrationGrant(input)]);
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it("reports a failed insert instead of swallowing it, and returns false", async () => {
    const reportFailure = vi.fn();
    const error = { message: "permission denied", code: "42501" };
    const recorded = await recordSelfRegistrationGrant(
      { insertGrant: async () => ({ error }), reportFailure },
      input,
    );

    expect(recorded).toBe(false);
    expect(reportFailure).toHaveBeenCalledWith(error, {
      code: "42501",
      patient_id: "p-1",
    });
  });

  it("carries the caller's metadata into the failure report", async () => {
    const reportFailure = vi.fn();
    await recordSelfRegistrationGrant(
      {
        insertGrant: async () => ({ error: { message: "boom" } }),
        reportFailure,
      },
      { ...input, metadata: { booking_group_id: "bg-7" } },
    );

    expect(reportFailure).toHaveBeenCalledWith(
      { message: "boom" },
      { code: undefined, patient_id: "p-1", booking_group_id: "bg-7" },
    );
  });

  it("never fails the surrounding action when the reporter itself throws", async () => {
    await expect(
      recordSelfRegistrationGrant(
        {
          insertGrant: async () => ({ error: { message: "boom" } }),
          reportFailure: async () => {
            throw new Error("sentry down");
          },
        },
        input,
      ),
    ).resolves.toBe(false);
  });

  it("reports a thrown insert too — a network failure must not lose the submission", async () => {
    const reportFailure = vi.fn();
    const thrown = new TypeError("fetch failed");
    const recorded = await recordSelfRegistrationGrant(
      {
        insertGrant: async () => {
          throw thrown;
        },
        reportFailure,
      },
      input,
    );

    expect(recorded).toBe(false);
    expect(reportFailure).toHaveBeenCalledWith(thrown, {
      code: undefined,
      patient_id: "p-1",
    });
  });
});
