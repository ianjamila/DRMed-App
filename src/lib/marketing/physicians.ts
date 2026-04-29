// Physician roster mirrored from drmed.ph/pages/physician-schedule.
// Photos saved to public/doctors/<slug>.jpg.
// Schedules change frequently — edit this file (or move to DB later) when they do.

export type PhysicianGroup =
  | "OB-GYN and Family Medicine"
  | "Pediatrics"
  | "Internal Medicine Subspecialties"
  | "ENT and Other Specialists";

export interface Physician {
  slug: string;
  name: string;
  specialty: string;
  group: PhysicianGroup;
  schedule: string[];
}

export const PHYSICIANS: Physician[] = [
  // OB-GYN and Family Medicine
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

  // Pediatrics
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

  // Internal Medicine Subspecialties
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

  // ENT and Other Specialists
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

export const PHYSICIAN_GROUPS: PhysicianGroup[] = [
  "OB-GYN and Family Medicine",
  "Pediatrics",
  "Internal Medicine Subspecialties",
  "ENT and Other Specialists",
];

export function physiciansByGroup(): Record<PhysicianGroup, Physician[]> {
  const out = {
    "OB-GYN and Family Medicine": [],
    Pediatrics: [],
    "Internal Medicine Subspecialties": [],
    "ENT and Other Specialists": [],
  } as Record<PhysicianGroup, Physician[]>;
  for (const p of PHYSICIANS) out[p.group].push(p);
  return out;
}

export function physicianInitials(name: string): string {
  // "Dr. Maria Cecilia Castelo-Brojas" -> "MC"
  const stripped = name.replace(/^Dr\.\s*/, "");
  const parts = stripped.split(/[\s-]+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts[parts.length - 1]?.[0] ?? "";
  return (first + last).toUpperCase();
}
