import { useEffect, useState } from "react";

const THEMES = [
  ["pro", "Pro"],
  ["daylight", "Daylight"],
  ["tron", "Tron"],
  ["cyberpunk", "Cyberpunk"],
  ["quantum", "Quantum"],
  ["matrix", "Matrix"],
  ["solar", "Solar"],
] as const;
const KEY = "argus-theme";

function apply(theme: string) {
  if (theme === "daylight") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}

/** Header dropdown for the colour theme. Pro is the default; the choice is remembered per browser. */
export function ThemePicker() {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem(KEY) ?? "pro";
    } catch {
      return "pro";
    }
  });
  useEffect(() => {
    apply(theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* storage unavailable: theme still applies for this visit */
    }
  }, [theme]);
  return (
    <select className="theme-pick" value={theme} onChange={(e) => setTheme(e.target.value)} aria-label="Colour theme" title="Colour theme">
      {THEMES.map(([v, l]) => (
        <option key={v} value={v}>
          ◐ {l}
        </option>
      ))}
    </select>
  );
}
