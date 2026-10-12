"use client";

import Link from "next/link";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useActiveSection } from "@/components/ScrollSpy";
import { facts } from "@/lib/facts";
import { SECTIONS } from "@/app/how-it-works/sections";


/**
 * The rail, as a client component.
 *
 * Only because of the scroll indicator: the nav needs to know which section is
 * in view, which cannot be done during a server render. Split out here so the
 * page itself stays a server component and costs nothing extra to render.
 *
 * `aria-current="location"` marks the active link for assistive technology -
 * the same information the border is carrying visually.
 */
export function HowItWorksRail() {
  const ids = SECTIONS.map((s) => s.id);
  const active = useActiveSection(ids);

  return (
    <aside className="rail">
      {/* Top-left, above the wordmark: the first control on the page. */}
      <ThemeToggle />

      <h1 className="wordmark">
        <Link href="/" className="wordmarkLink">
          DocSearch
        </Link>
      </h1>
      <p className="wordmarkSub">Semantic search over three manuals. Retrieval only.</p>

      <nav className="contentsHeading" aria-label="On this page">
        <ul className="contentsList">
          {SECTIONS.map(({ id, label }) => {
            const isActive = active === id;
            return (
              <li key={id}>
                <a
                  className={`contentsItem ${isActive ? "contentsItemActive" : ""}`}
                  href={`#${id}`}
                  aria-current={isActive ? "location" : undefined}
                >
                  <span className="contentsItemLabel">
                    <span className="contentsItemName">{label}</span>
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      </nav>

      <p className="contentsNote">
        Measured on {facts.generated} against the deployed index. Regenerate with{" "}
        <code>npm run db:stats -- --facts</code>.
      </p>
    </aside>
  );
}