interface NameParseResult {
  first_name: string | null;
  last_name: string | null;
  middle_name: string | null;
  unparseable: boolean;
}

/**
 * Parse the legacy CSV's "Full Name" column which is conventionally
 * "Last, First" or "Last, First Middle". Falls back to dedicated
 * Last/First columns when Full Name is empty.
 */
export function parseName(
  fullName: string | undefined | null,
  lastFallback: string | undefined | null,
  firstFallback: string | undefined | null,
  middleFallback: string | undefined | null,
): NameParseResult {
  const full = (fullName ?? "").trim();

  if (full && full.includes(",")) {
    const [rawLast, ...restParts] = full.split(",");
    const rest = restParts.join(",").trim();
    const last = titleCase(rawLast.trim());
    if (!rest) {
      return { first_name: null, last_name: last || null, middle_name: null, unparseable: !last };
    }
    const tokens = rest.split(/\s+/);
    const first = titleCase(tokens[0]);
    const middle = tokens.length > 1 ? titleCase(tokens.slice(1).join(" ")) : null;
    return {
      first_name: first || null,
      last_name: last || null,
      middle_name: middle || null,
      unparseable: !last && !first,
    };
  }

  // Full Name absent or no comma — try dedicated columns.
  const first = titleCase((firstFallback ?? "").trim());
  const last  = titleCase((lastFallback  ?? "").trim());
  const middle = titleCase((middleFallback ?? "").trim());
  if (first || last) {
    return {
      first_name: first || null,
      last_name: last || null,
      middle_name: middle || null,
      unparseable: false,
    };
  }

  // Some rows have only Full Name without a comma, e.g. "Jane Doe".
  if (full) {
    const tokens = full.split(/\s+/);
    if (tokens.length === 1) {
      return { first_name: titleCase(tokens[0]), last_name: null, middle_name: null, unparseable: false };
    }
    return {
      first_name: titleCase(tokens[0]),
      last_name: titleCase(tokens[tokens.length - 1]),
      middle_name: tokens.length > 2 ? titleCase(tokens.slice(1, -1).join(" ")) : null,
      unparseable: false,
    };
  }

  return { first_name: null, last_name: null, middle_name: null, unparseable: true };
}

function titleCase(input: string): string {
  if (!input) return "";
  return input
    .toLowerCase()
    .split(/(\s|-|')/g)
    .map((part) => (/[a-z]/i.test(part) ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join("");
}
