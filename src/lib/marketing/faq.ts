export interface FaqItem {
  question: string;
  answer: string;
}

export const FAQ_ITEMS: readonly FaqItem[] = [
  {
    question: "Do I need to fast before my test?",
    answer:
      "Blood sugar (FBS) and lipid tests need 8–10 hours of fasting — water is fine. Most other tests don't require it. Unsure? Message us before your visit and we'll confirm.",
  },
  {
    question: "Can I use my HMO?",
    answer:
      "Yes — we're accredited with 10 major HMO providers. Bring your HMO card and a valid ID; reception processes your LOA and covered services are cashless.",
  },
  {
    question: "How do I get my results?",
    answer:
      "Most tests release within 24 hours. We email you when they're ready, and you can view and download the official signed PDF anytime in the patient portal using your DRM-ID and the Secure PIN on your receipt.",
  },
  {
    question: "Do you see children?",
    answer:
      "Yes — we have pediatricians on staff. Schedules can change, so kindly call or message us first to confirm availability before bringing your little one in.",
  },
  {
    question: "Can you come to my home or office?",
    answer:
      "Yes — our team comes to your home or office for lab sample collection (subject to availability). Consultations are done in the clinic, though some doctors offer online consultations by appointment. Book online or message us, and reception will call to confirm the schedule and fee.",
  },
] as const;
