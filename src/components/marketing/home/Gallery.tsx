import Image from "next/image";
import { SectionHeading } from "@/components/marketing/ui";
import { Reveal } from "@/components/marketing/motion";

const GALLERY_PHOTOS = [
  {
    src: "/photos/reception.jpg",
    alt: "DRMed Clinic and Laboratory reception counter with staff greeting a patient",
    caption: "Reception — where every visit begins",
  },
  {
    src: "/photos/microscope.jpg",
    alt: "Olympus microscope at the DRMed clinical microscopy bench",
    caption: "Clinical microscopy — precision diagnostics",
  },
  {
    src: "/photos/lab-chemistry.jpg",
    alt: "DRMed clinical chemistry analyzer station",
    caption: "Clinical chemistry — our in-house lab",
  },
  {
    src: "/photos/waiting-area.jpg",
    alt: "DRMed Clinic and Laboratory waiting area",
    caption: "A comfortable place to wait",
  },
] as const;

export function Gallery() {
  return (
    <section className="py-[72px]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading eyebrow="Our Clinic" title="A look" accent="inside." className="mb-8" />

        <div className="grid grid-cols-2 gap-[14px] lg:grid-cols-4">
          {GALLERY_PHOTOS.map(({ src, alt, caption }) => (
            <Reveal key={src}>
              <div>
                {/* Sources are 3:4 portrait — match the box aspect so the full
                    scene shows (object-cover would otherwise slice a thin band). */}
                <Image
                  src={src}
                  alt={alt}
                  width={600}
                  height={800}
                  sizes="(min-width: 1024px) 25vw, 50vw"
                  className="aspect-[3/4] w-full rounded-[16px] object-cover shadow-[var(--shadow-warm-sm)]"
                />
                <p className="mt-2 text-[12px] italic text-[color:var(--color-ink-soft)]">
                  {caption}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
