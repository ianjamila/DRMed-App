// Brand identity, contact info, and shared marketing copy.
// Pulled from the existing drmed.ph site so the new build matches.

export const SITE = {
  name: "DRMed Clinic & Laboratory",
  shortName: "drmed.ph",
  tagline: "Your Family's Well-Being is Our Mission.",
  description:
    "Comprehensive medical services including doctor's consultations, laboratory tests, X-ray, ultrasound, ECG, home service and mobile clinic — at up to 50% less than hospitals.",
  url: process.env.NEXT_PUBLIC_SITE_URL ?? "https://drmed.ph",
  locale: "en-PH",
} as const;

export const CONTACT = {
  address: {
    line1: "4/F DRMed Clinic & Laboratory",
    line2: "Northridge Plaza, Congressional Avenue",
    city: "Quezon City",
    region: "Metro Manila",
    country: "PH",
    full: "4/F DRMed Clinic & Laboratory, Northridge Plaza, Congressional Avenue, Quezon City",
  },
  phone: {
    mobile: "0916 604 3208",
    mobileE164: "+639166043208",
    landline: "(02) 8 355 3517",
    landlineE164: "+63283553517",
  },
  email: "drmedhealthcare@gmail.com",
  hours: "Monday – Saturday, 8 AM – 5 PM",
} as const;

export const SOCIAL = {
  facebook: "https://www.facebook.com/drmedcliniclab/",
  instagram:
    "https://www.instagram.com/drmed.ph?igsh=Yzl4eDY3bXFyMnQy&utm_source=qr",
} as const;

export const HERO_STATS = [
  { value: "19+", label: "Specialist Physicians" },
  { value: "10+", label: "HMO Partners" },
  { value: "50%", label: "Less vs. Hospitals" },
  { value: "24h", label: "Average Turnaround" },
] as const;

export const TRUST_BAR = [
  { icon: "🏥", title: "Accredited Clinic & Lab", sub: "DOH-compliant facility" },
  { icon: "⚡", title: "Results in 24 Hours", sub: "Most tests same-day" },
  { icon: "💰", title: "Up to 50% Less", sub: "vs. hospitals & other clinics" },
  { icon: "🏠", title: "Home & Mobile Service", sub: "We come to you" },
  { icon: "💳", title: "HMO Accepted", sub: "10 major providers" },
] as const;

// Marketing-page service overview. The /services pages read live data from the
// `services` table; this is just the homepage card grid with icons.
export const SERVICE_HIGHLIGHTS = [
  {
    icon: "🩺",
    name: "Doctor's Consultation",
    desc: "Initial and follow-up consultations with our team of licensed physicians and specialists.",
    price: "from ₱500",
  },
  {
    icon: "🧪",
    name: "Laboratory Tests",
    desc: "CBC, urinalysis, blood chemistry, lipid profiles, thyroid panels, and more.",
    price: "Varies by test",
  },
  {
    icon: "🩻",
    name: "X-Ray Imaging",
    desc: "Digital chest X-ray with rapid radiologist interpretation.",
    price: "from ₱550",
  },
  {
    icon: "🫀",
    name: "ECG",
    desc: "12-lead electrocardiogram with same-day results and physician interpretation.",
    price: "Inquire",
  },
  {
    icon: "🔊",
    name: "Ultrasound",
    desc: "Whole abdomen, pelvic, thyroid, and other ultrasound services available.",
    price: "Inquire",
  },
  {
    icon: "📋",
    name: "Fit to Work / Pre-Employment",
    desc: "Complete medical clearance packages for individuals and corporate clients.",
    price: "from ₱400",
  },
  {
    icon: "🏠",
    name: "Home Service",
    desc: "Lab collection and medical consultation brought directly to your home or office.",
    price: "Inquire",
  },
  {
    icon: "🚐",
    name: "Mobile Clinic",
    desc: "Bring the clinic to your community, school, or company for mass health screenings.",
    price: "Inquire",
  },
] as const;

export const PACKAGE_GROUPS = [
  {
    type: "Preventive Care",
    title: "Basic, Routine, and Annual Checkups",
    desc: "Most requested screening bundles for regular health monitoring and annual assessment.",
    range: "Starts at ₱950 · up to ₱1,999",
    items: ["Basic Package", "Routine Package (Most Popular)", "Annual Physical Exam"],
  },
  {
    type: "Executive",
    title: "Professional and Executive Panels",
    desc: "Comprehensive health profiles with imaging, ECG, and advanced blood work for professionals.",
    range: "From ₱5,888",
    items: ["Standard Executive", "Comprehensive Executive", "Deluxe Executive"],
  },
  {
    type: "Specialized Lab Tests",
    title: "Focused Diagnostic Panels",
    desc: "Targeted test sets for thyroid, lipid, kidney, liver, and iron-related monitoring.",
    range: "From ₱699",
    items: [
      "Thyroid Function Package",
      "Lipid, Liver, and Kidney Panels",
      "Iron Deficiency Package",
    ],
  },
  {
    type: "Custom Plans",
    title: "Corporate and Group Packages",
    desc: "Pre-employment, annual corporate screening, and customized diagnostics based on company needs.",
    range: "Custom quote",
    items: [
      "Fit-to-work and onboarding bundles",
      "Onsite and volume screening options",
      "Flexible inclusions by request",
    ],
  },
] as const;

export const NAV_LINKS = [
  { href: "/#services", label: "Services" },
  { href: "/packages", label: "Packages" },
  { href: "/physicians", label: "Specialists" },
  { href: "/#hmo", label: "HMO" },
  { href: "/#contact", label: "Contact" },
] as const;
