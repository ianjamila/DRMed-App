import { describe, expect, it } from "vitest";
import {
  CONSENT_NOTICE_ARCHIVE,
  CONSENT_NOTICE_SECTIONS,
  CONSENT_STATEMENT,
  CURRENT_CONSENT_NOTICE_VERSION,
  consentNoticeText,
} from "./notice";

describe("consent notice archive", () => {
  it("holds the live wording under the current version", () => {
    // Fails when the notice wording or the clinic's contact details change
    // without a version bump. Fix: bump CURRENT_CONSENT_NOTICE_VERSION and ADD
    // an archive entry for it — never edit an existing one, because patients
    // agreed to those exact words.
    expect(CONSENT_NOTICE_ARCHIVE[CURRENT_CONSENT_NOTICE_VERSION]).toEqual({
      sections: CONSENT_NOTICE_SECTIONS,
      statement: CONSENT_STATEMENT,
    });
  });

  it("keys every entry by a YYYY-MM-DD version", () => {
    for (const version of Object.keys(CONSENT_NOTICE_ARCHIVE)) {
      expect(version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("returns null for a version that was never archived", () => {
    expect(consentNoticeText("1999-01-01")).toBeNull();
    expect(consentNoticeText("toString")).toBeNull();
    expect(consentNoticeText(CURRENT_CONSENT_NOTICE_VERSION)).not.toBeNull();
  });
});
