# Photos needed — DRMed marketing redesign

Every image slot on the shipped marketing pages, where the file lives, the
rendered crop, and its status. Production photos live in `public/` (gallery set
in `public/photos/`). Regenerated from the bundle's `PHOTO-MANIFEST.md`.

| # | Slot (page · section) | Production path | Rendered crop | Source aspect | Status |
|---|---|---|---|---|---|
| 1 | Homepage · hero main image | `public/hero-clinic.jpg` | arch-top frame, 420–520px tall, cover | ~4:3 landscape | ✅ Real photo (in repo) |
| 2 | Homepage · hero inset card | `public/photos/phlebotomist.jpg` | 150px card, cover, focus `center 30%` | 3:4 portrait | ⚠️ **PENDING** — `PendingPhoto` fallback renders until supplied. Spec: real phlebotomist + patient, natural window light, warm grade, faces consented |
| 3 | Homepage · portal section | `public/photos/patient-phone.jpg` | 230px tall, cover, radius 20 | 16:10 landscape | ⚠️ **PENDING** — `PendingPhoto` fallback renders until supplied. Spec: patient at home reviewing results on phone, soft morning light |
| 4 | Homepage · gallery 1 | `public/photos/reception.jpg` | 190px tall, cover, focus `center 35%` | 3:4 | ✅ Real photo (in repo) |
| 5 | Homepage · gallery 2 | `public/photos/microscope.jpg` | 190px tall, cover, focus `center 40%` | 3:4 | ✅ Real photo (in repo) |
| 6 | Homepage · gallery 3 | `public/photos/lab-chemistry.jpg` | 190px tall, cover | 9:16 | ✅ Real photo (in repo) |
| 7 | Homepage · gallery 4 | `public/photos/waiting-area.jpg` | 190px tall, cover, focus `center 55%` | 3:4 | ✅ Real photo (in repo) |
| 8 | Homepage · specialists grid | DB-driven (`doctor-avatar` / `public/doctors/*`) | 3:4 frame, cover, top-cropped | varies | ✅ Real headshots — first 6 physicians by display order |
| 9 | Homepage · HMO marquee | `public/hmo/*.png` (10 files) | 84px pill, contain | logo lockups | ✅ All 10 partner logos present |
| 10 | Booking + nav · header logo | `public/logo.png` | 30px tall | wordmark lockup | ⚠️ 394KB PNG — served via `next/image` with explicit sizing (see phase b/f) |

## Pending shoots (replace the two `PendingPhoto` fallbacks)

When the real assets arrive, drop them at the paths above and replace the
`PendingPhoto` component at each slot with a `next/image` of the same dimensions
— the fallback is sized to the exact box, so there is zero layout shift.

- Match the warm editorial grade of the gallery set; avoid blue-fluorescent
  clinical lighting.
- Export at ~2× the rendered crop for retina; compress to web-size JPEG
  (quality ~0.82, max ~1100px wide).

_Status as of phase a. Updated through phase f._
