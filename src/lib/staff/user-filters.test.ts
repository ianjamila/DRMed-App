import { describe, expect, it } from "vitest";
import {
  filterStaffRows,
  parseRoleFilter,
  parseSignInFilter,
  parseStatusFilter,
  type FilterableStaffRow,
} from "./user-filters";

function row(over: Partial<FilterableStaffRow> = {}): FilterableStaffRow {
  return {
    full_name: "FREYA MARY JILLIANNE DYLIM",
    email: "freyadylimx@gmail.com",
    role: "medtech",
    is_active: true,
    sign_in: { google: false, password: true },
    ...over,
  };
}

describe("parseRoleFilter", () => {
  it("accepts every real role", () => {
    expect(parseRoleFilter("admin")).toBe("admin");
    expect(parseRoleFilter("xray_technician")).toBe("xray_technician");
  });

  it("falls back to all for junk, empty and missing values", () => {
    expect(parseRoleFilter("wizard")).toBe("all");
    expect(parseRoleFilter("")).toBe("all");
    expect(parseRoleFilter(undefined)).toBe("all");
  });
});

describe("parseStatusFilter", () => {
  it("accepts active and inactive", () => {
    expect(parseStatusFilter("active")).toBe("active");
    expect(parseStatusFilter("inactive")).toBe("inactive");
  });

  it("falls back to all", () => {
    expect(parseStatusFilter("deleted")).toBe("all");
    expect(parseStatusFilter(undefined)).toBe("all");
  });
});

describe("parseSignInFilter", () => {
  it("accepts google and password_only", () => {
    expect(parseSignInFilter("google")).toBe("google");
    expect(parseSignInFilter("password_only")).toBe("password_only");
  });

  it("falls back to all", () => {
    expect(parseSignInFilter("password")).toBe("all");
    expect(parseSignInFilter(undefined)).toBe("all");
  });
});

const ALL = { q: "", role: "all", status: "all", signIn: "all" } as const;

describe("filterStaffRows", () => {
  it("returns everything when nothing is filtered", () => {
    const rows = [row(), row({ full_name: "Ian Jamila" })];
    expect(filterStaffRows(rows, ALL)).toHaveLength(2);
  });

  it("matches a name case-insensitively", () => {
    const rows = [row({ full_name: "Ian Jamila" }), row()];
    expect(filterStaffRows(rows, { ...ALL, q: "JAMILA" })).toHaveLength(1);
  });

  // Substring matching, like the patients search — so a short token can match
  // inside a longer word ("ian" is inside "JILLIANNE"). Documented rather than
  // "fixed": word-boundary matching would stop "dyl" finding DYLIM, which is
  // the more common way an admin actually types a partial name.
  it("matches inside a word", () => {
    expect(
      filterStaffRows([row({ full_name: "FREYA MARY JILLIANNE DYLIM" })], {
        ...ALL,
        q: "ian",
      }),
    ).toHaveLength(1);
  });

  it("matches on email", () => {
    const rows = [row(), row({ email: "recep.drmed@gmail.com" })];
    const hit = filterStaffRows(rows, { ...ALL, q: "recep" });
    expect(hit.map((r) => r.email)).toEqual(["recep.drmed@gmail.com"]);
  });

  // The role label, not the raw enum — an admin types what the column shows.
  it("matches on the role label rather than the stored value", () => {
    const rows = [
      row({ role: "medtech" }),
      row({ role: "xray_technician", full_name: "Tech Two" }),
    ];
    expect(filterStaffRows(rows, { ...ALL, q: "x-ray" })).toHaveLength(1);
    expect(filterStaffRows(rows, { ...ALL, q: "medical tech" })).toHaveLength(1);
  });

  // Token-based like the patients search: order must not matter.
  it("requires every token to match, in any order", () => {
    const rows = [row({ full_name: "Ian Jamila", role: "admin" })];
    expect(filterStaffRows(rows, { ...ALL, q: "jamila ian" })).toHaveLength(1);
    expect(filterStaffRows(rows, { ...ALL, q: "ian admin" })).toHaveLength(1);
    expect(filterStaffRows(rows, { ...ALL, q: "ian reception" })).toHaveLength(
      0,
    );
  });

  it("ignores surrounding and repeated whitespace in the query", () => {
    const rows = [row({ full_name: "Ian Jamila" })];
    expect(filterStaffRows(rows, { ...ALL, q: "   ian   " })).toHaveLength(1);
  });

  it("filters by role", () => {
    const rows = [row({ role: "admin" }), row({ role: "medtech" })];
    expect(filterStaffRows(rows, { ...ALL, role: "admin" })).toHaveLength(1);
  });

  it("filters by status", () => {
    const rows = [row({ is_active: true }), row({ is_active: false })];
    expect(filterStaffRows(rows, { ...ALL, status: "active" })).toHaveLength(1);
    expect(filterStaffRows(rows, { ...ALL, status: "inactive" })).toHaveLength(
      1,
    );
  });

  it("filters to staff who have migrated to Google", () => {
    const rows = [
      row({ sign_in: { google: true, password: true } }),
      row({ sign_in: { google: false, password: true } }),
    ];
    expect(filterStaffRows(rows, { ...ALL, signIn: "google" })).toHaveLength(1);
  });

  // The migration lens: "who still has to be moved over".
  it("password_only excludes anyone who also has Google", () => {
    const rows = [
      row({ sign_in: { google: true, password: true } }),
      row({ sign_in: { google: false, password: true } }),
      row({ sign_in: { google: true, password: false } }),
    ];
    const hit = filterStaffRows(rows, { ...ALL, signIn: "password_only" });
    expect(hit).toHaveLength(1);
    expect(hit[0]?.sign_in).toEqual({ google: false, password: true });
  });

  it("password_only excludes a user with no identities at all", () => {
    const rows = [row({ sign_in: { google: false, password: false } })];
    expect(
      filterStaffRows(rows, { ...ALL, signIn: "password_only" }),
    ).toHaveLength(0);
  });

  it("applies filters together", () => {
    const rows = [
      row({ role: "admin", is_active: true, full_name: "Ian Jamila" }),
      row({ role: "admin", is_active: false, full_name: "Old Admin" }),
      row({ role: "medtech", is_active: true, full_name: "Ian Medtech" }),
    ];
    const hit = filterStaffRows(rows, {
      ...ALL,
      q: "ian",
      role: "admin",
      status: "active",
    });
    expect(hit.map((r) => r.full_name)).toEqual(["Ian Jamila"]);
  });

  it("preserves the incoming order", () => {
    const rows = [
      row({ full_name: "A" }),
      row({ full_name: "B" }),
      row({ full_name: "C" }),
    ];
    expect(filterStaffRows(rows, ALL).map((r) => r.full_name)).toEqual([
      "A",
      "B",
      "C",
    ]);
  });

  it("does not mutate the array it is given", () => {
    const rows = [row({ role: "admin" }), row({ role: "medtech" })];
    filterStaffRows(rows, { ...ALL, role: "admin" });
    expect(rows).toHaveLength(2);
  });
});
