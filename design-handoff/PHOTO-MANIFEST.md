# Photo manifest — DRMed 2026 redesign

Every image slot on the shipped pages, its expected production path, and its
status. Production photos live in **`/public/photos/`** in the Next.js repo
(this bundle's `assets/photos/` maps 1:1).

| # | Slot (page · section) | File | Rendered crop | Source aspect | Status |
|---|---|---|---|---|---|
| 1 | Homepage · hero main image | `assets/hero-clinic.jpg` | arch-top frame, 420–520px tall, `object-fit: cover` | ~4:3 landscape | ✅ Real photo supplied (from repo) |
| 2 | Homepage · hero inset card | `/public/photos/phlebotomist.jpg` | 150px tall card, cover, focus `center 30%` | 3:4 portrait (900×1205 comp) | ⚠️ **Pending final asset** — current file is an AI-generated comp. Spec: real phlebotomist + patient, natural window light, warm grade, faces consented |
| 3 | Homepage · portal section | `/public/photos/patient-phone.jpg` | 230px tall, cover, radius 20 | 16:10 landscape (1100×684 comp) | ⚠️ **Pending final asset** — AI comp. Spec: patient at home reviewing results on phone, soft morning light |
| 4 | Homepage · gallery 1 | `/public/photos/reception.jpg` | 190px tall, cover, focus `center 35%` | 3:4 (900×1200) | ✅ Real photo supplied |
| 5 | Homepage · gallery 2 | `/public/photos/microscope.jpg` | 190px tall, cover, focus `center 40%` | 3:4 (900×1200) | ✅ Real photo supplied |
| 6 | Homepage · gallery 3 | `/public/photos/lab-chemistry.jpg` | 190px tall, cover | 9:16 (900×1600) | ✅ Real photo supplied |
| 7 | Homepage · gallery 4 | `/public/photos/waiting-area.jpg` | 190px tall, cover, focus `center 55%` | 3:4 (900×1200) | ✅ Real photo supplied |
| 8 | Homepage · specialists grid | `assets/doctors/*.jpg` (6 files) | 3:4 frame, cover, top-cropped | varies | ✅ Real headshots (from repo) — 6 of 19+ physicians shown |
| 9 | Homepage · HMO marquee | `assets/hmo/*.png` (6 files) | 84px pill, `object-fit: contain` | logo lockups | ✅ Real logos — **6 of the 10 claimed partners**; add the remaining 4 logos |
| 10 | Booking · header logo | `assets/logo.png` | 30px tall | wordmark lockup | ✅ Supplied |

Notes
- All photos are compressed to web-size JPEG (quality 0.82, max ~1100px wide).
  Re-export from originals at 2× the rendered crop for retina if desired.
- When replacing #2 and #3, match the warm editorial grade of the gallery set;
  avoid blue-fluorescent clinical lighting.
