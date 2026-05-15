/**
 * Seeds the physician roster from src/lib/marketing/physicians.ts into the
 * physicians + physician_schedules tables. Idempotent: upserts physicians
 * on `slug`, then replaces each physician's recurring schedule rows.
 *
 * Single-time entries ("Saturday · 4:00 PM" with no end time) get a
 * default 2-hour window — admin can edit via /staff/admin/physicians/[id]/schedule
 * once Phase 9.4 ships.
 *
 * "By appointment" entries are skipped — those physicians end up with
 * zero recurring rows and are filtered out of the online booking picker
 * (reception still books them via the internal flow).
 *
 *   npm run seed:physicians
 */
import { createClient } from "@supabase/supabase-js";
import type { Database, TablesInsert } from "../src/types/database";
import { requireLocalOrExplicitProd } from "./lib/env-guard";

// Bootstrap roster — mirrors the original drmed.ph physician-schedule page.
// Once seeded into the DB, ongoing edits happen via /staff/admin/physicians.
// Kept inline so a fresh DB can be re-bootstrapped without depending on a
// no-longer-existing static module.
interface SeedPhysician {
  slug: string;
  name: string;
  specialty: string;
  group: string;
  schedule: string[];
}

const PHYSICIANS: SeedPhysician[] = [
  {
    slug: "maria-cecilia-castelo-brojas",
    name: "Dr. Maria Cecilia Castelo-Brojas",
    specialty: "OB-GYN",
    group: "OB-GYN and Family Medicine",
    schedule: ["Monday and Wednesday · 10:00 AM – 12:00 NN", "By appointment"],
  },
  {
    slug: "nadia-mariano",
    name: "Dr. Nadia Mariano",
    specialty: "OB-GYN",
    group: "OB-GYN and Family Medicine",
    schedule: ["Saturday · 4:00 PM", "By appointment"],
  },
  {
    slug: "julie-ann-pacis-caling",
    name: "Dr. Julie Ann Pacis-Caling",
    specialty: "Family Medicine",
    group: "OB-GYN and Family Medicine",
    schedule: ["Monday · 9:30 AM – 11:30 AM"],
  },
  {
    slug: "armelle-keisha-mendoza",
    name: "Dr. Armelle Keisha Mendoza",
    specialty: "Family Medicine",
    group: "OB-GYN and Family Medicine",
    schedule: [
      "Monday · 1:00 PM – 5:00 PM",
      "Tuesday · 8:00 AM – 3:00 PM",
      "Thursday · 2:00 PM – 5:00 PM",
      "Friday · 8:00 AM – 4:00 PM",
      "Saturday · 8:00 AM – 12:00 NN",
    ],
  },
  {
    slug: "jaemari-elleazar",
    name: "Dr. Jaemari Elleazar",
    specialty: "Family Medicine",
    group: "OB-GYN and Family Medicine",
    schedule: ["Wednesday and Thursday · 8:00 AM – 12:00 NN"],
  },
  {
    slug: "katherine-gayo",
    name: "Dr. Katherine Gayo",
    specialty: "Pediatrician",
    group: "Pediatrics",
    schedule: [
      "Monday, Wednesday, Friday · 10:00 AM – 12:00 NN",
      "Saturday · 2:00 PM – 4:00 PM",
    ],
  },
  {
    slug: "dominique-antonio",
    name: "Dr. Dominique Antonio",
    specialty: "Pediatrician",
    group: "Pediatrics",
    schedule: ["Tuesday and Friday · 1:00 PM – 4:00 PM"],
  },
  {
    slug: "aurora-vicencio",
    name: "Dr. Aurora Vicencio",
    specialty: "Pediatrician",
    group: "Pediatrics",
    schedule: ["By appointment"],
  },
  {
    slug: "robert-vicencio",
    name: "Dr. Robert Vicencio",
    specialty: "Internal Medicine · Cardiologist",
    group: "Internal Medicine Subspecialties",
    schedule: [
      "Tuesday · 5:00 PM – 7:00 PM",
      "Saturday · 3:00 PM – 5:00 PM",
      "By appointment",
    ],
  },
  {
    slug: "archangel-manuel",
    name: "Dr. Archangel Manuel",
    specialty: "Internal Medicine · Pulmonologist",
    group: "Internal Medicine Subspecialties",
    schedule: ["Wednesday · 2:00 PM – 4:00 PM", "By appointment"],
  },
  {
    slug: "ferdinand-dantes",
    name: "Dr. Ferdinand Dantes",
    specialty: "Internal Medicine · Gastroenterologist",
    group: "Internal Medicine Subspecialties",
    schedule: ["Friday · 3:00 PM – 5:00 PM", "By appointment"],
  },
  {
    slug: "angelle-dantes",
    name: "Dr. Angelle Dantes",
    specialty: "Internal Medicine · Oncologist",
    group: "Internal Medicine Subspecialties",
    schedule: ["By appointment"],
  },
  {
    slug: "lei-baldeviso",
    name: "Dr. Lei Baldeviso",
    specialty: "Internal Medicine · Diabetologist",
    group: "Internal Medicine Subspecialties",
    schedule: ["By appointment"],
  },
  {
    slug: "gideon-libiran",
    name: "Dr. Gideon Libiran",
    specialty: "Internal Medicine · Nephrologist",
    group: "Internal Medicine Subspecialties",
    schedule: ["By appointment"],
  },
  {
    slug: "angelica-lorenzo",
    name: "Dr. Angelica Lorenzo",
    specialty: "ENT",
    group: "ENT and Other Specialists",
    schedule: [
      "Tuesday · 9:00 AM – 11:00 AM",
      "Saturday · 4:00 PM – 6:00 PM",
      "By appointment",
    ],
  },
  {
    slug: "claudette-anglo",
    name: "Dr. Claudette Anglo",
    specialty: "ENT",
    group: "ENT and Other Specialists",
    schedule: [
      "Thursday · 1:00 PM – 3:00 PM",
      "Friday · 10:00 AM – 12:00 NN",
      "By appointment",
    ],
  },
  {
    slug: "alain-arcega",
    name: "Dr. Alain Arcega",
    specialty: "Ophthalmologist",
    group: "ENT and Other Specialists",
    schedule: ["Tuesday and Friday · 9:00 AM", "By appointment"],
  },
  {
    slug: "daniel-john-mariano",
    name: "Dr. Daniel John Mariano",
    specialty: "Radiologist",
    group: "ENT and Other Specialists",
    schedule: ["Wednesday and Friday · 8:00 AM", "By appointment"],
  },
  {
    slug: "mary-rose-alvarez",
    name: "Dr. Mary Rose Alvarez",
    specialty: "Surgeon",
    group: "ENT and Other Specialists",
    schedule: ["By appointment"],
  },
  {
    slug: "lizcel-alonzo",
    name: "Dr. Lizcel Alonzo",
    specialty: "Psychiatrist",
    group: "ENT and Other Specialists",
    schedule: ["By appointment"],
  },
];

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local",
  );
  process.exit(1);
}

requireLocalOrExplicitProd("seed:physicians");

const admin = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const DAY_LOOKUP: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

interface ParsedBlock {
  day_of_week: number;
  start_time: string; // HH:MM:SS
  end_time: string;
}

// "10:00 AM" → "10:00:00"; "12:00 NN" → "12:00:00"; "5:00 PM" → "17:00:00".
function parseTime(t: string): string {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM|NN)$/i.exec(t.trim());
  if (!m) throw new Error(`Cannot parse time: "${t}"`);
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const meridiem = m[3]!.toUpperCase();
  if (meridiem === "AM" && hour === 12) hour = 0;
  else if (meridiem === "PM" && hour < 12) hour += 12;
  // NN = noon = 12:00; no adjustment beyond that.
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
}

function addHours(time: string, hours: number): string {
  const [h, m, s] = time.split(":").map(Number);
  const total = h! * 60 + m! + hours * 60;
  const newH = Math.floor(total / 60) % 24;
  const newM = total % 60;
  return `${String(newH).padStart(2, "0")}:${String(newM).padStart(2, "0")}:${String(s ?? 0).padStart(2, "0")}`;
}

// "Monday and Wednesday · 10:00 AM – 12:00 NN" → 2 ParsedBlock rows.
// "Tuesday and Friday · 9:00 AM" (single time) → 2 blocks, 2-hour window each.
function parseScheduleEntry(entry: string): ParsedBlock[] {
  const trimmed = entry.trim();
  if (/^by appointment$/i.test(trimmed)) return [];

  const parts = trimmed.split("·").map((s) => s.trim());
  if (parts.length !== 2) {
    console.warn(`  skipped (no '·' separator): ${entry}`);
    return [];
  }
  const [daysPart, timesPart] = parts;
  const dayTokens = daysPart!
    .replace(/\s+and\s+/gi, ",")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  const dows = dayTokens
    .map((d) => DAY_LOOKUP[d])
    .filter((n): n is number => n !== undefined);
  if (dows.length === 0) {
    console.warn(`  skipped (no known day in "${daysPart}"): ${entry}`);
    return [];
  }

  const range = timesPart!.split(/[–—\-]/); // en/em dash or hyphen
  let start: string;
  let end: string;
  if (range.length === 2) {
    start = parseTime(range[0]!);
    end = parseTime(range[1]!);
  } else if (range.length === 1) {
    start = parseTime(range[0]!);
    end = addHours(start, 2);
  } else {
    console.warn(`  skipped (cannot parse times "${timesPart}"): ${entry}`);
    return [];
  }

  return dows.map((day_of_week) => ({
    day_of_week,
    start_time: start,
    end_time: end,
  }));
}

async function main() {
  console.log(`Seeding ${PHYSICIANS.length} physicians…`);

  // Upsert all physician rows first so we have stable IDs to attach
  // schedules to. Use `display_order` to preserve the static module's
  // order on the public roster.
  const physicianRows: TablesInsert<"physicians">[] = PHYSICIANS.map(
    (p, idx) => ({
      slug: p.slug,
      full_name: p.name,
      specialty: p.specialty,
      group_label: p.group,
      photo_path: `legacy/${p.slug}.jpg`, // marker for the static-photo fallback
      display_order: idx,
      is_active: true,
    }),
  );

  const { data: upserted, error: upsertErr } = await admin
    .from("physicians")
    .upsert(physicianRows, { onConflict: "slug", ignoreDuplicates: false })
    .select("id, slug");
  if (upsertErr || !upserted) {
    throw new Error(`physicians upsert failed: ${upsertErr?.message}`);
  }

  const slugToId = new Map(upserted.map((r) => [r.slug, r.id]));
  console.log(`✓ ${upserted.length} physicians upserted`);

  // Replace recurring schedules for each physician.
  let totalBlocks = 0;
  for (const p of PHYSICIANS) {
    const physicianId = slugToId.get(p.slug);
    if (!physicianId) continue;

    const blocks: ParsedBlock[] = [];
    for (const entry of p.schedule) blocks.push(...parseScheduleEntry(entry));

    // Wipe and reinsert so re-runs are deterministic.
    await admin
      .from("physician_schedules")
      .delete()
      .eq("physician_id", physicianId);

    if (blocks.length === 0) {
      console.log(`  - ${p.slug}: by-appointment only (no recurring)`);
      continue;
    }

    const insertRows: TablesInsert<"physician_schedules">[] = blocks.map(
      (b) => ({
        physician_id: physicianId,
        day_of_week: b.day_of_week,
        start_time: b.start_time,
        end_time: b.end_time,
      }),
    );
    const { error } = await admin
      .from("physician_schedules")
      .insert(insertRows);
    if (error) {
      console.error(`  ✗ ${p.slug}: ${error.message}`);
      continue;
    }
    totalBlocks += blocks.length;
    console.log(`  + ${p.slug}: ${blocks.length} blocks`);
  }

  console.log(`\n✓ ${totalBlocks} schedule blocks total`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
