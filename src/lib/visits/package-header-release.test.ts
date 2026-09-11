import { describe, expect, it } from "vitest";
import {
  canManuallyReleasePackageHeader,
  type PackageComponentForRelease,
  type PackageHeaderForRelease,
} from "./package-header-release";

function header(status: string): PackageHeaderForRelease {
  return { status };
}

function components(
  statuses: string[],
): PackageComponentForRelease[] {
  return statuses.map((status) => ({ status }));
}

describe("canManuallyReleasePackageHeader", () => {
  it("allows release when every component is released", () => {
    expect(
      canManuallyReleasePackageHeader(
        header("ready_for_release"),
        components(["released", "released", "released"]),
      ),
    ).toBe(true);
  });

  it("allows release when some components are cancelled but at least one released", () => {
    expect(
      canManuallyReleasePackageHeader(
        header("ready_for_release"),
        components(["released", "cancelled"]),
      ),
    ).toBe(true);
  });

  it("refuses when any component is still pending", () => {
    expect(
      canManuallyReleasePackageHeader(
        header("ready_for_release"),
        components(["released", "ready_for_release"]),
      ),
    ).toBe(false);
  });

  it("refuses an all-cancelled package — that's the cascade-cancel path", () => {
    expect(
      canManuallyReleasePackageHeader(
        header("ready_for_release"),
        components(["cancelled", "cancelled"]),
      ),
    ).toBe(false);
  });

  it("refuses a header that isn't sitting at ready_for_release", () => {
    expect(
      canManuallyReleasePackageHeader(
        header("released"),
        components(["released"]),
      ),
    ).toBe(false);
    expect(
      canManuallyReleasePackageHeader(
        header("requested"),
        components(["released"]),
      ),
    ).toBe(false);
  });

  it("refuses a header with no components linked yet", () => {
    expect(
      canManuallyReleasePackageHeader(header("ready_for_release"), []),
    ).toBe(false);
  });
});
