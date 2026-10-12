"use client";

import { useState } from "react";

type Theme = "light" | "dark";

const STORAGE_KEY = "docsearch-theme";

/**
 * Applies the stored theme before first paint.
 *
 * Inlined into <head> rather than run from a component, because a component
 * effect fires after the browser has already painted. That is one frame of
 * white on a dark-mode device, which is exactly the flash dark mode exists to
 * avoid. This script is deliberately tiny and defensive: if storage is blocked
 * it simply does nothing and the OS preference still applies through CSS.
 */
export const themeScript = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  STORAGE_KEY,
)});if(t==="dark"||t==="light"){document.documentElement.setAttribute("data-theme",t);}}catch(e){}})();`;

/**
 * Light / dark toggle.
 *
 * The current theme is read during render rather than set in an effect. The
 * inline head script has already written data-theme by the time this renders,
 * so the attribute is authoritative and there is nothing to synchronise - an
 * effect would only duplicate state that already exists, and would add a frame
 * in which the two disagree.
 *
 * Both labels are always present in the markup and the active one is marked in
 * CSS, so the server-rendered HTML already says which theme is active. A toggle
 * whose label is decided by JavaScript reads "Light" on a dark page for as long
 * as hydration takes.
 */
export function ThemeToggle() {
  const [override, setOverride] = useState<Theme | null>(null);

  const theme: Theme =
    override ??
    (typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-theme") === "dark"
      ? "dark"
      : "light");

  const apply = (next: Theme) => {
    setOverride(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage can be blocked in private browsing. The theme still applies for
      // this page view; it just will not be remembered.
    }
  };
  return (
    <div className="themeToggle" role="group" aria-label="Colour theme">
      <button
        type="button"
        className="themeButton"
        onClick={() => apply("light")}
        aria-pressed={theme === "light"}
      >
        <span className="themeButtonLabel" data-active={theme === "light"}>
          Light
        </span>
      </button>
      <button
        type="button"
        className="themeButton"
        onClick={() => apply("dark")}
        aria-pressed={theme === "dark"}
      >
        <span className="themeButtonLabel" data-active={theme === "dark"}>
          Dark
        </span>
      </button>
    </div>
  );
}