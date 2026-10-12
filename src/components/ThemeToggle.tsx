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
 * avoid.
 *
 * Deliberately defensive: if storage is blocked it does nothing and the OS
 * preference still applies through CSS, so the page is never stuck in the
 * wrong theme because a preference could not be read.
 */
export const themeScript = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  STORAGE_KEY,
)});if(t==="dark"||t==="light"){document.documentElement.setAttribute("data-theme",t);}}catch(e){}})();`;

/** What the system currently asks for, used when the visitor has no stored choice. */
function systemTheme(): Theme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Light / dark toggle.
 *
 * One button, not a pair. A two-button "Light | Dark" control is the shape
 * people sketch first and almost no production site ships, because it spends
 * twice the space to say less: the state is already legible from the page, and
 * the icon is what communicates it.
 *
 * The icon shows the theme you would switch *to*, which is the convention on
 * every site that gets this right - GitHub, Vercel, Tailwind. An icon showing
 * the current state means the thing you want is never the thing you can see.
 *
 * Both icons are always in the markup and CSS decides which is visible, keyed
 * on the same attribute that carries the theme. Nothing here re-renders to
 * change the icon, so there is no frame in which the markup and the theme
 * disagree - the head script has already set the attribute before this runs.
 */
export function ThemeToggle() {
  const [override, setOverride] = useState<Theme | null>(null);

  const current: Theme =
    override ??
    (typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-theme") === "dark"
      ? "dark"
      : systemTheme());

  const next: Theme = current === "dark" ? "light" : "dark";

  const toggle = () => {
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
    <button
      type="button"
      className="themeToggle"
      onClick={toggle}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
    >
      {/* Sun: shown while dark, since that is where you switch to light. */}
      <svg className="themeIcon themeIconSun" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="4.25" />
        <path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.2 5.2l1.8 1.8M17 17l1.8 1.8M18.8 5.2 17 7M7 17l-1.8 1.8" />
      </svg>
      {/* Moon: shown while light. */}
      <svg className="themeIcon themeIconMoon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.2 8.2 0 1 0 10.2 10.2Z" />
      </svg>
    </button>
  );
}