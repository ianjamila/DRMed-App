import type { Metadata } from "next";
import { Public_Sans, Montserrat, Instrument_Serif } from "next/font/google";
import { SITE } from "@/lib/marketing/site";
import "./globals.css";

const publicSans = Public_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

const montserrat = Montserrat({
  variable: "--font-heading",
  subsets: ["latin"],
  weight: ["600", "700", "800", "900"],
  display: "swap",
});

// Marketing display serif — italic accents in headlines. Single weight (400),
// normal + italic. Self-hosted at build by next/font (satisfies "self-hosted").
const instrumentSerif = Instrument_Serif({
  variable: "--font-display",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: {
    default: `${SITE.name} — ${SITE.tagline}`,
    template: `%s — ${SITE.shortName}`,
  },
  description: SITE.description,
  openGraph: {
    type: "website",
    locale: "en_PH",
    siteName: SITE.shortName,
    url: SITE.url,
    title: SITE.name,
    description: SITE.description,
  },
  twitter: {
    card: "summary_large_image",
    title: SITE.name,
    description: SITE.description,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang={SITE.locale}
      className={`${publicSans.variable} ${montserrat.variable} ${instrumentSerif.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-white text-[color:var(--color-brand-text)]">
        {children}
      </body>
    </html>
  );
}
