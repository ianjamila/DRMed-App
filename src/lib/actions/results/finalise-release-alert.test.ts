import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const schedule = vi.fn();
vi.mock("@/lib/notifications/release-staff-alert", () => ({ scheduleReleaseStaffAlert: (...a: unknown[]) => schedule(...a) }));

import { announceFinaliseRelease } from "./finalise-release-alert";

beforeEach(() => schedule.mockReset());

describe("announceFinaliseRelease", () => {
  it("announces a complete release with the released count", () => {
    announceFinaliseRelease({ visitId: "v1", releaseDeferred: false, requestedIds: ["a","b","c"], releasedCount: 3 });
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledWith("v1", 3);
  });
  it("sends nothing when payment/consent deferred the release", () => {
    announceFinaliseRelease({ visitId: "v1", releaseDeferred: true, requestedIds: ["a","b","c"], releasedCount: 0 });
    expect(schedule).not.toHaveBeenCalled();
  });
  it("sends nothing for a sign-off partial (fewer rows than ids)", () => {
    announceFinaliseRelease({ visitId: "v1", releaseDeferred: false, requestedIds: ["a","b","c"], releasedCount: 2 });
    expect(schedule).not.toHaveBeenCalled();
  });
  it("sends nothing when a concurrent release matched zero rows", () => {
    announceFinaliseRelease({ visitId: "v1", releaseDeferred: false, requestedIds: ["a","b","c"], releasedCount: 0 });
    expect(schedule).not.toHaveBeenCalled();
  });
  it("sends nothing for an empty request", () => {
    announceFinaliseRelease({ visitId: "v1", releaseDeferred: false, requestedIds: [], releasedCount: 0 });
    expect(schedule).not.toHaveBeenCalled();
  });
  it("counts duplicate ids once, so they cannot suppress the alert", () => {
    announceFinaliseRelease({ visitId: "v1", releaseDeferred: false, requestedIds: ["a", "b", "a"], releasedCount: 2 });
    expect(schedule).toHaveBeenCalledWith("v1", 2);
  });
});
