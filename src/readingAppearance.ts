import { defaults, type Preferences } from "./model";

export const pagePalettes = {
  light: { background: "#ffffff", text: "#293541" },
  sepia: { background: "#f4ecd9", text: "#443b2c" },
  dark: { background: "#202830", text: "#e1e5e8" },
} as const;

/** Upgrade once, so choosing Original later stays a deliberate preference. */
export function comfortablePreferences(saved?: Preferences): Preferences {
  return {
    ...defaults,
    ...saved,
    theme: saved?.comfortDefaultsVersion
      ? saved.theme
      : saved?.theme === "dark" ? "dark" : "sepia",
    comfortDefaultsVersion: 1,
  };
}
