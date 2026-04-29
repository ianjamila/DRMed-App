// Accredited HMO partners — logos saved to public/hmo/<slug>.png.

export interface HmoPartner {
  slug: string;
  name: string;
}

export const HMO_PARTNERS: HmoPartner[] = [
  { slug: "maxicare", name: "Maxicare" },
  { slug: "intellicare", name: "Intellicare" },
  { slug: "valucare", name: "ValuCare" },
  { slug: "cocolife", name: "Cocolife" },
  { slug: "etiqa", name: "Etiqa" },
  { slug: "medasia-avega", name: "MedAsia AVEGA" },
  { slug: "generali", name: "Generali" },
  { slug: "amaphil", name: "Amaphil" },
  { slug: "philhealth", name: "PhilHealth" },
  { slug: "icare", name: "iCare" },
];
