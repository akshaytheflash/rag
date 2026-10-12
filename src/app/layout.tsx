import type { Metadata } from "next";
import { Instrument_Serif, IBM_Plex_Mono } from "next/font/google";
import { themeScript } from "@/components/ThemeToggle";
import "./globals.css";

const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-instrument-serif",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "DocSearch — official Python, FastAPI and PostgreSQL docs",
  description:
    "Ask a question and get back the passages that match it, copied verbatim from the official Python, FastAPI and PostgreSQL documentation, each linking to its source page, with a cited answer written from them.",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${instrumentSerif.variable} ${plexMono.variable}`}>
      <head>
        {/* Sets the theme before first paint. See themeScript. */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <a className="skipLink" href="#search">
          Skip to search
        </a>
        {children}
      </body>
    </html>
  );
}
