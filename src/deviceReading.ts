import { db } from "./db";
import { defaultPdfLayout, type PdfLayout, type Preferences } from "./model";

export type DeviceReading = {
  pdfLayout?: PdfLayout;
  zoom?: number;
  rotation?: number;
  width?: number;
  flow?: Preferences["flow"];
  spread?: boolean;
};
export async function readDeviceReading(id: string): Promise<DeviceReading> {
  try {
    return JSON.parse(
      (await db.meta.get(`device-reading:${id}`))?.value || "{}",
    );
  } catch {
    return {};
  }
}
export async function writeDeviceReading(id: string, patch: DeviceReading) {
  await db.transaction("rw", db.meta, async () => {
    const prior = await readDeviceReading(id);
    await db.meta.put({
      key: `device-reading:${id}`,
      value: JSON.stringify({ ...prior, ...patch }),
    });
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
