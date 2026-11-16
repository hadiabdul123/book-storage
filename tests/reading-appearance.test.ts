import { describe, expect, it } from "vitest";
import { comfortablePreferences } from "../src/readingAppearance";
import { defaults } from "../src/model";

describe("comfortable reading defaults", () => {
  it("opens new and legacy white readers on warm paper without losing typography", () => {
    expect(comfortablePreferences()).toMatchObject({ theme: "sepia", comfortDefaultsVersion: 1 });
    expect(comfortablePreferences({ ...defaults, theme: "light", fontSize: 28 })).toMatchObject({
      theme: "sepia", fontSize: 28, comfortDefaultsVersion: 1,
    });
  });
  it("preserves a dark reader and respects Original after the one-time upgrade", () => {
    expect(comfortablePreferences({ ...defaults, theme: "dark" }).theme).toBe("dark");
    const original = { ...comfortablePreferences(), theme: "light" as const };
    expect(comfortablePreferences(original)).toEqual(original);
  });
});
