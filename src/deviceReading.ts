import { db } from "./db";
import { defaultPdfLayout, type PdfLayout, type Preferences } from "./model";

export type DeviceReading = Partial<Pick<Preferences, "theme" | "font" | "fontSize" | "lineHeight">> & {
  pageTurnEffect?: "curl" | "none";
  pdfOriginalColors?: boolean;
  swipeToTurn?: boolean;
  hidePageControls?: boolean;
  pdfLayout?: PdfLayout;
  zoom?: number;
  rotation?: number;
  width?: number;
  flow?: Preferences["flow"];
  spread?: boolean;
};
const defaultsKey = "device-reading:defaults:v1";
const documentKeys = ["rotation", "pdfOriginalColors"] as const;
async function storedReading(key: string): Promise<DeviceReading> {
  try { return JSON.parse((await db.meta.get(key))?.value || "{}"); } catch { return {}; }
}
export async function readDeviceReading(id: string): Promise<DeviceReading> {
  const [legacy, global] = await Promise.all([storedReading(`device-reading:${id}`), db.meta.get(defaultsKey)]);
  if (!global) return legacy;
  const appearance = await storedReading(defaultsKey);
  return { ...appearance, rotation: legacy.rotation, pdfOriginalColors: legacy.pdfOriginalColors };
}
/** Seed once, atomically, before constructing the first reader on this device. */
export async function initializeDeviceReading(id: string, seed: DeviceReading): Promise<DeviceReading> {
  await db.transaction("rw", db.meta, async () => {
    if (await db.meta.get(`${defaultsKey}:seeded`)) return;
    const next = { ...seed, ...await storedReading(`device-reading:${id}`), ...await storedReading(defaultsKey) };
    for (const key of documentKeys) delete next[key];
    await db.meta.put({ key: defaultsKey, value: JSON.stringify(next) });
    await db.meta.put({ key: `${defaultsKey}:seeded`, value: "1" });
  });
  return readDeviceReading(id);
}
export async function writeDeviceReading(id: string, patch: DeviceReading | ((prior: DeviceReading) => DeviceReading)) {
  await db.transaction("rw", db.meta, async () => {
    const prior = await readDeviceReading(id);
    const update = typeof patch === "function" ? patch(prior) : patch;
    const global = { ...prior, ...update };
    for (const key of documentKeys) delete global[key];
    await db.meta.put({ key: defaultsKey, value: JSON.stringify(global) });
    const document = await storedReading(`device-reading:${id}`);
    for (const key of documentKeys) if (update[key] !== undefined) Object.assign(document, { [key]: update[key] });
    await db.meta.put({ key: `device-reading:${id}`, value: JSON.stringify(document) });
  });
}
export function devicePdfLayout(
  local: DeviceReading | undefined,
  legacy: PdfLayout | undefined,
  phone: boolean,
) {
  return (
    local?.pdfLayout || (phone ? defaultPdfLayout : legacy) || defaultPdfLayout
  );
}
