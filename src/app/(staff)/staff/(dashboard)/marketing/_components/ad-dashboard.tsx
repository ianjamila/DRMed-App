"use client";

// Ad-spend analytics dashboard, ported from the standalone marketing-kit tool
// (DRMed-marketing-kit/dashboards/drmed-ad-dashboard.jsx). Fully client-side:
// staff upload Meta/Google CSV exports, rows persist in localStorage, and a
// deterministic sample dataset renders until real data is loaded. Keeps the
// marketing kit's own palette (distinct from the staff-portal brand tokens) so
// the tool matches its printed companion materials.

import {
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ChangeEvent,
  type ReactNode,
} from "react";
import dynamic from "next/dynamic";
import {
  Upload,
  RotateCcw,
  Download,
  Wallet,
  Users,
  Target,
  MousePointerClick,
  Activity,
  ArrowDown,
  type LucideIcon,
} from "lucide-react";

/* ---------- palette (inline styles; no arbitrary Tailwind values) ---------- */
const C = {
  ink: "#0B3A3D",
  bg: "#EDF2F1",
  surface: "#FFFFFF",
  line: "#D8E4E2",
  sub: "#5C7271",
  text: "#11302F",
  meta: "#5B6CFF",
  google: "#1FA37A",
  accent: "#E8743B",
  good: "#1B9C76",
  warn: "#C98A00",
  bad: "#D1503F",
};
const STORE_KEY = "drmed_ad_data_v1";
const num: CSSProperties = { fontVariantNumeric: "tabular-nums" };

/* ---------- formatting ---------- */
// Locale pinned to en-PH so server render and any browser locale agree
// (prevents hydration text mismatches on the number grouping).
const peso = (n: number) => "₱" + Math.round(n || 0).toLocaleString("en-PH");
const int = (n: number) => Math.round(n || 0).toLocaleString("en-PH");
const pct = (n: number) => (isFinite(n) ? n.toFixed(1) : "0.0") + "%";
const safe = (a: number, b: number) => (b ? a / b : 0);

/* ---------- charts (recharts code-split; loaded on demand) ---------- */
function ChartFallback({ height }: { height: number }) {
  return (
    <div
      style={{ height, display: "grid", placeItems: "center", color: C.sub, fontSize: 12 }}
    >
      Loading chart…
    </div>
  );
}
const SpendDonut = dynamic(() => import("./ad-charts").then((m) => m.SpendDonut), {
  ssr: false,
  loading: () => <ChartFallback height={210} />,
});
const SpendTrend = dynamic(() => import("./ad-charts").then((m) => m.SpendTrend), {
  ssr: false,
  loading: () => <ChartFallback height={232} />,
});

/* ---------- row shapes ---------- */
interface AdRow {
  date: string;
  platform: string;
  campaign: string;
  ad: string;
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  bookings: number;
}

interface GroupTotals {
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  bookings: number;
}

interface GroupedRow extends GroupTotals {
  name: string;
  platforms: Set<string>;
}

interface AdGroupedRow extends GroupTotals {
  name: string;
  campaign: string;
  platform: string;
}

interface DayPoint {
  date: string;
  spend: number;
  bookings: number;
  leads: number;
}

type SortKey =
  | "name"
  | "platform"
  | "spend"
  | "clicks"
  | "ctr"
  | "leads"
  | "bookings"
  | "cpb"
  | "cpl";

interface SortState {
  key: SortKey;
  dir: "asc" | "desc";
}

// Hydration flag without a setState-in-an-effect step: the server snapshot is
// false, the client snapshot is true, so the first post-hydration render flips
// it (same useSyncExternalStore approach as run-review-client.tsx).
const emptySubscribe = () => () => {};
const getHydrated = () => true;
const getServerHydrated = () => false;

function isAdRow(v: unknown): v is AdRow {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>; // narrowed to object above
  return (
    typeof r.date === "string" &&
    typeof r.platform === "string" &&
    typeof r.campaign === "string" &&
    typeof r.ad === "string" &&
    typeof r.spend === "number" &&
    typeof r.impressions === "number" &&
    typeof r.clicks === "number" &&
    typeof r.leads === "number" &&
    typeof r.bookings === "number"
  );
}

// Read previously uploaded rows from localStorage. SSR-guarded so the lazy
// useState initializers below can call it on the server too (returns null
// there; the render is gated on hydration anyway).
function loadStoredRows(): AdRow[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const rows = parsed.filter(isAdRow);
    return rows.length ? rows : null;
  } catch {
    /* corrupt or blocked storage — fall back to sample */
    return null;
  }
}

/* ---------- deterministic sample data ---------- */
function mulberry32(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildSample(): AdRow[] {
  const rnd = mulberry32(42);
  const jit = (b: number, v: number) => b * (1 - v + rnd() * 2 * v);
  const combos: ReadonlyArray<
    readonly [string, string, string, number, number, number, number, number]
  > = [
    // campaign, platform, ad, dailySpend, cpc, ctr, leadRate, bookRate
    ["Beat the Hospital Price", "Google", "PEME · RSA", 320, 31, 0.061, 0.3, 0.72],
    ["Beat the Hospital Price", "Google", "Annual Exam · RSA", 240, 28, 0.058, 0.28, 0.7],
    ["Beat the Hospital Price", "Google", "Near-Me Tests · RSA", 180, 26, 0.055, 0.22, 0.65],
    ["Beat the Hospital Price", "Meta", "Price vs Hospital", 300, 9.6, 0.017, 0.16, 0.6],
    ["Beat the Hospital Price", "Meta", "PEME Job-seeker", 220, 9.2, 0.019, 0.18, 0.62],
    ["Beat the Hospital Price", "Meta", "Annual Checkup", 160, 10.4, 0.014, 0.13, 0.55],
    ["Corporate Health Partner", "Meta", "Onsite Pilot · Lead Gen", 260, 12.5, 0.012, 0.07, 0.22],
    ["Corporate Health Partner", "Google", "Corporate APE · RSA", 210, 38, 0.049, 0.16, 0.28],
    ["Results Tomorrow", "Meta", "No Rush Fee · Reel", 140, 8.4, 0.022, 0.15, 0.58],
    ["Specialist Spotlight", "Google", "Diabetologist · RSA", 120, 33, 0.052, 0.2, 0.6],
    ["Specialist Spotlight", "Google", "Pediatrician · RSA", 100, 30, 0.05, 0.21, 0.63],
  ];
  const rows: AdRow[] = [];
  const days = 28;
  const base = new Date(2026, 5, 15); // Jun 15 2026
  for (let d = 0; d < days; d++) {
    const date = new Date(base);
    date.setDate(base.getDate() - (days - 1 - d));
    const ramp = 0.75 + (d / days) * 0.5; // gentle upward trend
    for (const [campaign, platform, ad, ds, cpc, ctr, lr, br] of combos) {
      if (rnd() < 0.12) continue; // some days an ad is off
      const spend = jit(ds, 0.25) * ramp;
      const clicks = Math.max(1, Math.round(spend / jit(cpc, 0.12)));
      const impressions = Math.round(clicks / jit(ctr, 0.15));
      let leads = Math.round(clicks * jit(lr, 0.2));
      leads = Math.min(leads, clicks);
      let bookings = Math.round(leads * jit(br, 0.2));
      bookings = Math.min(bookings, leads);
      rows.push({
        date: date.toISOString().slice(0, 10),
        platform,
        campaign,
        ad,
        spend: Math.round(spend),
        impressions,
        clicks,
        leads,
        bookings,
      });
    }
  }
  return rows;
}

/* ---------- date normalization ---------- */
// Ad exports carry dates in several shapes: ISO ("2026-06-15", sometimes with a
// trailing time or as a "start - end" range), US slashes ("06/15/2026"),
// day-first slashes ("15/06/2026"), or a textual month ("Jun 15, 2026").
// Normalize them all to ISO YYYY-MM-DD so date grouping, sorting, and the trend
// chart stay chronological. Slash dates are read month-first, falling back to
// day-first only when the first field is too large to be a month.
function normalizeDate(raw: string): string {
  const s = String(raw).trim();
  if (!s) return "";
  const pad = (n: number) => String(n).padStart(2, "0");

  // ISO anywhere in the string (handles a trailing time or a leading range date).
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // Slash- or dot-separated numeric dates.
  const parts = s.match(/^(\d{1,4})[/.](\d{1,2})[/.](\d{1,4})$/);
  if (parts) {
    const [, a, b, c] = parts;
    if (a.length === 4) return `${a}-${pad(+b)}-${pad(+c)}`; // Y/M/D
    let month = +a;
    let day = +b;
    if (month > 12) [month, day] = [day, month]; // first field is day-first
    const year = c.length <= 2 ? 2000 + +c : +c;
    return `${year}-${pad(month)}-${pad(day)}`;
  }

  // Textual months ("Jun 15, 2026", "15 June 2026") — parsed as a local date.
  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    const d = new Date(t);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // Unknown format — keep a bounded slice so grouping is at least stable.
  return s.slice(0, 10);
}

/* ---------- flexible CSV header mapping ---------- */
function mapRow(r: Record<string, string>): AdRow {
  const keys = Object.keys(r);
  const find = (...cands: string[]): string => {
    for (const c of cands) {
      const k = keys.find((key) => key.toLowerCase().trim().includes(c));
      if (k && r[k] !== "" && r[k] != null) return r[k];
    }
    return "";
  };
  const n = (v: string): number => {
    const x = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
    return isFinite(x) ? x : 0;
  };
  let platform = String(find("platform", "source", "network")).trim();
  if (/face|meta|insta|ig\b/i.test(platform)) platform = "Meta";
  else if (/google|search|goog|adwords/i.test(platform)) platform = "Google";
  return {
    date: normalizeDate(find("date", "day", "reporting")),
    platform: platform || "Other",
    campaign: String(find("campaign")).trim() || "Unattributed",
    ad: String(find("ad name", "ad ", "creative", "headline")).trim() || "—",
    spend: n(find("spend", "amount", "cost")),
    impressions: n(find("impr")),
    clicks: n(find("link click", "clicks", "click")),
    // "result" is a leads-only candidate: Meta exports often have a single
    // "Results" column, and listing it under bookings too would double-map the
    // same column into both fields (every funnel would show 100% lead→booking).
    leads: n(find("lead", "result", "conversation", "messag")),
    bookings: n(find("booking", "conversion", "purchase", "appointment")),
  };
}

const TEMPLATE =
  "platform,date,campaign,ad,spend,impressions,clicks,leads,bookings\nMeta,2026-06-15,Beat the Hospital Price,Price vs Hospital,300,17600,300,48,29\nGoogle,2026-06-15,Beat the Hospital Price,PEME · RSA,320,170,10,3,2\n";

/* ---------- grouping + sorting (pure helpers) ---------- */
function groupBy(rows: AdRow[], key: "platform" | "campaign"): GroupedRow[] {
  const m: Record<string, GroupedRow> = {};
  for (const r of rows) {
    const k = r[key];
    m[k] ??= {
      name: k,
      spend: 0,
      impressions: 0,
      clicks: 0,
      leads: 0,
      bookings: 0,
      platforms: new Set<string>(),
    };
    m[k].spend += r.spend;
    m[k].impressions += r.impressions;
    m[k].clicks += r.clicks;
    m[k].leads += r.leads;
    m[k].bookings += r.bookings;
    m[k].platforms.add(r.platform);
  }
  return Object.values(m);
}

type SortableRow = GroupTotals & { name: string; platform?: string };

function sortRows<T extends SortableRow>(rows: T[], s: SortState): T[] {
  const get = (r: T): number | string => {
    switch (s.key) {
      case "ctr":
        return safe(r.clicks, r.impressions);
      case "cpb":
        return r.bookings ? r.spend / r.bookings : Infinity;
      case "cpl":
        return r.leads ? r.spend / r.leads : Infinity;
      case "name":
        return r.name;
      case "platform":
        return r.platform ?? "";
      default:
        return r[s.key];
    }
  };
  return [...rows].sort((a, b) => {
    const av = get(a);
    const bv = get(b);
    if (typeof av === "string" || typeof bv === "string") {
      return s.dir === "asc"
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    }
    return s.dir === "asc" ? av - bv : bv - av;
  });
}

const platColor = (p: string) =>
  p === "Meta" ? C.meta : p === "Google" ? C.google : C.sub;

/* ---------- small UI atoms ---------- */
function Kpi({
  icon: Icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div
      className="rounded-2xl p-4 flex-1 min-w-0"
      style={{ background: C.surface, border: `1px solid ${C.line}` }}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="rounded-lg p-1.5" style={{ background: (accent || C.ink) + "14" }}>
          <Icon size={15} style={{ color: accent || C.ink }} />
        </span>
        <span
          className="text-xs font-medium uppercase"
          style={{ color: C.sub, letterSpacing: ".06em" }}
        >
          {label}
        </span>
      </div>
      <div className="text-2xl font-semibold leading-none" style={{ color: C.text, ...num }}>
        {value}
      </div>
      {sub && (
        <div className="text-xs mt-1.5" style={{ color: C.sub }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function Th({
  k,
  children,
  st,
  set,
  right,
}: {
  k: SortKey;
  children: ReactNode;
  st: SortState;
  set: (s: SortState) => void;
  right?: boolean;
}) {
  return (
    <th
      onClick={() => set({ key: k, dir: st.key === k && st.dir === "desc" ? "asc" : "desc" })}
      className={
        "px-3 py-2 text-xs font-semibold cursor-pointer select-none whitespace-nowrap " +
        (right ? "text-right" : "text-left")
      }
      style={{ color: st.key === k ? C.ink : C.sub }}
    >
      {children}
      {st.key === k ? (st.dir === "desc" ? " ↓" : " ↑") : ""}
    </th>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { v: string; l: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="text-sm rounded-lg px-2.5 py-1.5 outline-none"
      style={{ background: C.surface, border: `1px solid ${C.line}`, color: C.text }}
    >
      {options.map((o) => (
        <option key={o.v} value={o.v}>
          {o.l}
        </option>
      ))}
    </select>
  );
}

function Card({
  title,
  children,
  pad = true,
}: {
  title: string;
  children: ReactNode;
  pad?: boolean;
}) {
  return (
    <div className="rounded-2xl" style={{ background: "#FFFFFF", border: `1px solid ${C.line}` }}>
      <div className="px-4 pt-3 pb-2 text-sm font-semibold" style={{ color: C.ink }}>
        {title}
      </div>
      <div className={pad ? "px-4 pb-4" : "pb-1"}>{children}</div>
    </div>
  );
}

/* ============================ component ============================ */
export function AdPerformanceDashboard() {
  // Persisted rows are read once, lazily, in the initializers below (no
  // setState-in-effect rehydration step). `hydrated` gates the render so the
  // server (which can't see localStorage) never paints mismatched HTML.
  const hydrated = useSyncExternalStore(emptySubscribe, getHydrated, getServerHydrated);
  const [stored] = useState(() => loadStoredRows());
  const [data, setData] = useState<AdRow[]>(() => stored ?? buildSample());
  const [source, setSource] = useState<"sample" | "uploaded">(stored ? "uploaded" : "sample");
  const [platformF, setPlatformF] = useState("All");
  const [periodF, setPeriodF] = useState("28");
  const [target, setTarget] = useState(450);
  // Editable draft of the target field, so it can be cleared mid-edit without
  // the numeric `target` (used by the KPI math) snapping to 0 on every keystroke.
  const [targetDraft, setTargetDraft] = useState("450");
  const [sort, setSort] = useState<SortState>({ key: "spend", dir: "desc" });
  const [adSort, setAdSort] = useState<SortState>({ key: "spend", dir: "desc" });
  const [note, setNote] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const dates = useMemo(() => [...new Set(data.map((r) => r.date))].sort(), [data]);
  const filtered = useMemo(() => {
    let rows = data;
    if (platformF !== "All") rows = rows.filter((r) => r.platform === platformF);
    if (periodF !== "all" && dates.length) {
      const keep = new Set(dates.slice(-parseInt(periodF, 10)));
      rows = rows.filter((r) => keep.has(r.date));
    }
    return rows;
  }, [data, platformF, periodF, dates]);

  const tot = useMemo(() => {
    const t: GroupTotals = { spend: 0, impressions: 0, clicks: 0, leads: 0, bookings: 0 };
    for (const r of filtered) {
      t.spend += r.spend;
      t.impressions += r.impressions;
      t.clicks += r.clicks;
      t.leads += r.leads;
      t.bookings += r.bookings;
    }
    return t;
  }, [filtered]);

  const byPlatform = useMemo(() => groupBy(filtered, "platform"), [filtered]);
  const byCampaign = useMemo(() => groupBy(filtered, "campaign"), [filtered]);
  const byAd = useMemo(() => {
    const m: Record<string, AdGroupedRow> = {};
    for (const r of filtered) {
      const k = r.platform + " | " + r.campaign + " | " + r.ad;
      m[k] ??= {
        name: r.ad,
        campaign: r.campaign,
        platform: r.platform,
        spend: 0,
        impressions: 0,
        clicks: 0,
        leads: 0,
        bookings: 0,
      };
      m[k].spend += r.spend;
      m[k].impressions += r.impressions;
      m[k].clicks += r.clicks;
      m[k].leads += r.leads;
      m[k].bookings += r.bookings;
    }
    return Object.values(m);
  }, [filtered]);

  const byDate = useMemo(() => {
    const m: Record<string, DayPoint> = {};
    for (const r of filtered) {
      m[r.date] ??= { date: r.date, spend: 0, bookings: 0, leads: 0 };
      m[r.date].spend += r.spend;
      m[r.date].bookings += r.bookings;
      m[r.date].leads += r.leads;
    }
    return Object.values(m)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => ({ ...d, label: d.date.slice(5).replace("-", "/") }));
  }, [filtered]);

  /* ---------- handlers ---------- */
  const onUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    if (!file) return;
    // papaparse is only needed once a staff member actually uploads a CSV, so
    // load it on demand to keep it out of the dashboard's initial JS bundle.
    const { default: Papa } = await import("papaparse");
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const rows = res.data
          .map(mapRow)
          .filter((r) => r.spend > 0 || r.clicks > 0 || r.impressions > 0);
        if (!rows.length) {
          setNote("Couldn't read that file. Check it has spend/clicks columns — or use the template.");
          return;
        }
        setData(rows);
        setSource("uploaded");
        setNote(`Loaded ${rows.length} rows from ${file.name}.`);
        try {
          window.localStorage.setItem(STORE_KEY, JSON.stringify(rows));
        } catch {
          /* storage full or blocked — rows stay in memory for this session */
        }
      },
      error: () => setNote("Couldn't parse that CSV."),
    });
    input.value = "";
  };
  const reset = () => {
    setData(buildSample());
    setSource("sample");
    setNote("");
    try {
      window.localStorage.removeItem(STORE_KEY);
    } catch {
      /* blocked storage — nothing to clear */
    }
  };
  const onTargetChange = (e: ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setTargetDraft(v);
    // Empty field stays empty while editing; keep the last committed target for
    // the KPI math and only commit a valid non-negative number.
    if (v.trim() === "") return;
    const parsed = parseInt(v, 10);
    if (Number.isFinite(parsed) && parsed >= 0) setTarget(parsed);
  };
  const onTargetBlur = () => {
    const parsed = parseInt(targetDraft, 10);
    if (targetDraft.trim() === "" || !Number.isFinite(parsed) || parsed < 0) {
      setTargetDraft(String(target)); // restore last good value
    } else {
      const clamped = Math.max(0, parsed);
      setTarget(clamped);
      setTargetDraft(String(clamped));
    }
  };
  const downloadTemplate = () => {
    const blob = new Blob([TEMPLATE], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "drmed-ads-template.csv";
    a.click();
  };

  const funnel = [
    { label: "Impressions", v: tot.impressions, c: C.ink },
    { label: "Clicks", v: tot.clicks, c: "#166E6E" },
    { label: "Leads", v: tot.leads, c: C.google },
    { label: "Patients captured", v: tot.bookings, c: C.accent },
  ];
  const fMax = funnel[0].v || 1;

  const statusOf = (cpb: number, bookings: number) =>
    bookings === 0
      ? { t: "No captures", c: C.sub }
      : cpb <= target
        ? { t: "On target", c: C.good }
        : cpb <= target * 1.5
          ? { t: "Watch", c: C.warn }
          : { t: "Over target", c: C.bad };

  if (!hydrated) return null;

  return (
    <div
      className="w-full rounded-2xl p-4 sm:p-6"
      style={{
        background: C.bg,
        color: C.text,
        fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      }}
    >
      <div className="mx-auto" style={{ maxWidth: 1120 }}>
        {/* header */}
        <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
          <div>
            <div className="flex items-center gap-2">
              <div
                className="rounded-lg px-2 py-1 text-xs font-bold"
                style={{ background: C.ink, color: "#fff", letterSpacing: ".04em" }}
              >
                DRMed
              </div>
              <h1 className="text-xl font-semibold" style={{ color: C.ink }}>
                Ad Performance
              </h1>
            </div>
            <p className="text-sm mt-1" style={{ color: C.sub }}>
              Spend, platform &amp; campaign performance, and patients captured ·{" "}
              {source === "sample" ? "sample data" : "your data"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={platformF}
              onChange={setPlatformF}
              options={[
                { v: "All", l: "All platforms" },
                { v: "Meta", l: "Meta" },
                { v: "Google", l: "Google" },
              ]}
            />
            <Select
              value={periodF}
              onChange={setPeriodF}
              options={[
                { v: "7", l: "Last 7 days" },
                { v: "28", l: "Last 28 days" },
                { v: "all", l: "All time" },
              ]}
            />
            <button
              onClick={() => fileRef.current?.click()}
              className="flex items-center gap-1.5 text-sm rounded-lg px-3 py-1.5 font-medium"
              style={{ background: C.ink, color: "#fff" }}
            >
              <Upload size={14} /> Upload CSV
            </button>
            <input ref={fileRef} type="file" accept=".csv" onChange={onUpload} className="hidden" />
            <button
              onClick={downloadTemplate}
              title="Download CSV template"
              className="flex items-center gap-1.5 text-sm rounded-lg px-2.5 py-1.5"
              style={{ background: C.surface, border: `1px solid ${C.line}`, color: C.sub }}
            >
              <Download size={14} />
            </button>
            {source === "uploaded" && (
              <button
                onClick={reset}
                title="Reset to sample"
                className="flex items-center gap-1.5 text-sm rounded-lg px-2.5 py-1.5"
                style={{ background: C.surface, border: `1px solid ${C.line}`, color: C.sub }}
              >
                <RotateCcw size={14} />
              </button>
            )}
          </div>
        </div>

        {note && (
          <div
            className="text-xs mb-3 rounded-lg px-3 py-2"
            style={{ background: "#fff", border: `1px solid ${C.line}`, color: C.sub }}
          >
            {note}
          </div>
        )}

        {/* KPIs */}
        <div className="flex flex-wrap gap-3 mb-4">
          <Kpi
            icon={Wallet}
            label="Ad spend"
            value={peso(tot.spend)}
            sub={`${dates.length ? Math.min(parseInt(periodF, 10) || dates.length, dates.length) : 0} days`}
            accent={C.ink}
          />
          <Kpi
            icon={Users}
            label="Patients captured"
            value={int(tot.bookings)}
            sub={`${int(tot.leads)} leads`}
            accent={C.accent}
          />
          <Kpi
            icon={Target}
            label="Cost / booking"
            value={peso(safe(tot.spend, tot.bookings))}
            sub={`target ≤ ${peso(target)}`}
            accent={safe(tot.spend, tot.bookings) <= target ? C.good : C.bad}
          />
          <Kpi
            icon={MousePointerClick}
            label="Avg CPC"
            value={peso(safe(tot.spend, tot.clicks))}
            sub={`${pct(safe(tot.clicks, tot.impressions) * 100)} CTR`}
            accent={C.ink}
          />
          <Kpi
            icon={Activity}
            label="Cost / lead"
            value={peso(safe(tot.spend, tot.leads))}
            sub={`${int(tot.clicks)} clicks`}
            accent={C.ink}
          />
        </div>

        {/* charts row */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-4">
          {/* spend by platform donut */}
          <Card title="Spend by platform">
            <SpendDonut
              data={byPlatform.map((p) => ({ name: p.name, spend: p.spend }))}
              colorOf={platColor}
              formatPeso={peso}
            />
            <div className="flex justify-center gap-4 -mt-2">
              {byPlatform.map((p) => (
                <div key={p.name} className="flex items-center gap-1.5 text-xs" style={{ color: C.sub }}>
                  <span
                    className="rounded-full"
                    style={{ width: 9, height: 9, background: platColor(p.name) }}
                  />
                  {p.name} · {peso(p.spend)}
                </div>
              ))}
            </div>
          </Card>

          {/* spend & captures over time */}
          <div className="lg:col-span-2">
            <Card title="Spend & patients captured over time">
              <SpendTrend
                data={byDate}
                colors={{ line: C.line, sub: C.sub, ink: C.ink, accent: C.accent }}
                formatPeso={peso}
                formatInt={int}
              />
            </Card>
          </div>
        </div>

        {/* funnel + platform cards */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-4">
          <Card title="Capture funnel">
            <div className="space-y-2 pt-1">
              {funnel.map((f, i) => (
                <div key={f.label}>
                  <div className="flex justify-between text-xs mb-1" style={{ color: C.sub }}>
                    <span>{f.label}</span>
                    <span style={num}>{int(f.v)}</span>
                  </div>
                  <div className="rounded-md overflow-hidden" style={{ background: C.bg, height: 22 }}>
                    <div
                      className="h-full rounded-md flex items-center justify-end pr-2"
                      style={{ width: Math.max(6, (f.v / fMax) * 100) + "%", background: f.c }}
                    >
                      {i > 0 && (
                        <span className="text-xs font-medium" style={{ color: "#fff", ...num }}>
                          {pct(safe(f.v, funnel[i - 1].v) * 100)}
                        </span>
                      )}
                    </div>
                  </div>
                  {i < funnel.length - 1 && (
                    <div className="flex justify-center">
                      <ArrowDown size={12} style={{ color: C.line }} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Card>

          <div className="lg:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-3">
            {byPlatform.map((p) => {
              const cpb = safe(p.spend, p.bookings);
              return (
                <div
                  key={p.name}
                  className="rounded-2xl p-4"
                  style={{
                    background: C.surface,
                    border: `1px solid ${C.line}`,
                    borderTop: `3px solid ${platColor(p.name)}`,
                  }}
                >
                  <div className="flex items-center justify-between mb-3">
                    <span className="font-semibold" style={{ color: C.text }}>
                      {p.name}
                    </span>
                    <span className="text-xs" style={{ color: C.sub, ...num }}>
                      {peso(p.spend)} spend
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-y-3 gap-x-2">
                    {(
                      [
                        ["Impr.", int(p.impressions)],
                        ["Clicks", int(p.clicks)],
                        ["CTR", pct(safe(p.clicks, p.impressions) * 100)],
                        ["CPC", peso(safe(p.spend, p.clicks))],
                        ["Leads", int(p.leads)],
                        ["Captured", int(p.bookings)],
                        ["CPL", peso(safe(p.spend, p.leads))],
                        ["Cost/book", peso(cpb)],
                        ["", ""],
                      ] as const
                    ).map(([k, v], i) =>
                      k ? (
                        <div key={i}>
                          <div className="text-xs" style={{ color: C.sub }}>
                            {k}
                          </div>
                          <div
                            className="text-sm font-semibold"
                            style={{
                              color: k === "Cost/book" ? (cpb <= target ? C.good : C.bad) : C.text,
                              ...num,
                            }}
                          >
                            {v}
                          </div>
                        </div>
                      ) : (
                        <div key={i} />
                      ),
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* campaign table */}
        <Card title="Campaign performance" pad={false}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: `1px solid ${C.line}` }}>
                  <Th k="name" st={sort} set={setSort}>
                    Campaign
                  </Th>
                  <th className="px-3 py-2 text-xs font-semibold text-left" style={{ color: C.sub }}>
                    Platforms
                  </th>
                  <Th k="spend" st={sort} set={setSort} right>
                    Spend
                  </Th>
                  <Th k="clicks" st={sort} set={setSort} right>
                    Clicks
                  </Th>
                  <Th k="ctr" st={sort} set={setSort} right>
                    CTR
                  </Th>
                  <Th k="leads" st={sort} set={setSort} right>
                    Leads
                  </Th>
                  <Th k="bookings" st={sort} set={setSort} right>
                    Captured
                  </Th>
                  <Th k="cpb" st={sort} set={setSort} right>
                    Cost/book
                  </Th>
                </tr>
              </thead>
              <tbody>
                {sortRows(byCampaign, sort).map((c) => {
                  const cpb = safe(c.spend, c.bookings);
                  return (
                    <tr key={c.name} style={{ borderBottom: `1px solid ${C.line}` }}>
                      <td className="px-3 py-2.5 font-medium" style={{ color: C.text }}>
                        {c.name}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="inline-flex gap-1">
                          {[...c.platforms].map((p) => (
                            <span
                              key={p}
                              className="rounded-full"
                              title={p}
                              style={{ width: 9, height: 9, background: platColor(p) }}
                            />
                          ))}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right" style={num}>
                        {peso(c.spend)}
                      </td>
                      <td className="px-3 py-2.5 text-right" style={{ color: C.sub, ...num }}>
                        {int(c.clicks)}
                      </td>
                      <td className="px-3 py-2.5 text-right" style={{ color: C.sub, ...num }}>
                        {pct(safe(c.clicks, c.impressions) * 100)}
                      </td>
                      <td className="px-3 py-2.5 text-right" style={{ color: C.sub, ...num }}>
                        {int(c.leads)}
                      </td>
                      <td className="px-3 py-2.5 text-right font-semibold" style={num}>
                        {int(c.bookings)}
                      </td>
                      <td
                        className="px-3 py-2.5 text-right font-semibold"
                        style={{ color: c.bookings ? (cpb <= target ? C.good : C.bad) : C.sub, ...num }}
                      >
                        {c.bookings ? peso(cpb) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>

        {/* ad table */}
        <div className="mt-4">
          <Card title="Ad performance" pad={false}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ borderBottom: `1px solid ${C.line}` }}>
                    <Th k="name" st={adSort} set={setAdSort}>
                      Ad
                    </Th>
                    <Th k="platform" st={adSort} set={setAdSort}>
                      Platform
                    </Th>
                    <Th k="spend" st={adSort} set={setAdSort} right>
                      Spend
                    </Th>
                    <Th k="ctr" st={adSort} set={setAdSort} right>
                      CTR
                    </Th>
                    <Th k="leads" st={adSort} set={setAdSort} right>
                      Leads
                    </Th>
                    <Th k="bookings" st={adSort} set={setAdSort} right>
                      Captured
                    </Th>
                    <Th k="cpb" st={adSort} set={setAdSort} right>
                      Cost/book
                    </Th>
                    <th className="px-3 py-2 text-xs font-semibold text-left" style={{ color: C.sub }}>
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortRows(byAd, adSort).map((a, i) => {
                    const cpb = safe(a.spend, a.bookings);
                    const s = statusOf(cpb, a.bookings);
                    return (
                      <tr key={i} style={{ borderBottom: `1px solid ${C.line}` }}>
                        <td className="px-3 py-2.5">
                          <div className="font-medium" style={{ color: C.text }}>
                            {a.name}
                          </div>
                          <div className="text-xs" style={{ color: C.sub }}>
                            {a.campaign}
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: C.sub }}>
                            <span
                              className="rounded-full"
                              style={{ width: 8, height: 8, background: platColor(a.platform) }}
                            />
                            {a.platform}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-right" style={num}>
                          {peso(a.spend)}
                        </td>
                        <td className="px-3 py-2.5 text-right" style={{ color: C.sub, ...num }}>
                          {pct(safe(a.clicks, a.impressions) * 100)}
                        </td>
                        <td className="px-3 py-2.5 text-right" style={{ color: C.sub, ...num }}>
                          {int(a.leads)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-semibold" style={num}>
                          {int(a.bookings)}
                        </td>
                        <td
                          className="px-3 py-2.5 text-right"
                          style={{ color: a.bookings ? (cpb <= target ? C.good : C.bad) : C.sub, ...num }}
                        >
                          {a.bookings ? peso(cpb) : "—"}
                        </td>
                        <td className="px-3 py-2.5">
                          <span
                            className="text-xs font-medium rounded-full px-2 py-0.5"
                            style={{ color: s.c, background: s.c + "16" }}
                          >
                            {s.t}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        {/* target control + footer */}
        <div className="flex flex-wrap items-center justify-between gap-3 mt-4">
          <label className="flex items-center gap-2 text-sm" style={{ color: C.sub }}>
            Target cost / booking
            <input
              type="number"
              inputMode="numeric"
              min={0}
              value={targetDraft}
              onChange={onTargetChange}
              onBlur={onTargetBlur}
              className="w-24 rounded-lg px-2 py-1 text-sm outline-none"
              style={{ background: C.surface, border: `1px solid ${C.line}`, color: C.text, ...num }}
            />
          </label>
          <p className="text-xs" style={{ color: C.sub }}>
            Upload your Meta + Google CSV exports (use the template). Your data stays in this browser.
          </p>
        </div>
      </div>
    </div>
  );
}
