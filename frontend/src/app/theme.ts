import { readPref, writePref } from "./prefs";

export type Theme = "system" | "light" | "dark";

export function applyTheme(t: Theme = readPref<Theme>("theme", "system")) {
  const root = document.documentElement;
  if (t === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", t);
}

export function setTheme(t: Theme) {
  writePref("theme", t);
  applyTheme(t);
}
