import { useEffect, useRef, useState, type RefObject } from "react";
import { bindReadingPointer } from "./reader/readingPointer";
import { defaultReadingPointer, readReadingPointer, readingPointerKey, saveReadingPointer, type ReadingPointerSettings } from "./readingPointerSettings";
import "./readingPointer.css";

export function useReadingPointer(host: RefObject<HTMLDivElement | null>, enabled: boolean, ready: number, notify: (message: string) => void) {
  const [settings, setSettings] = useState(() => {
    try { return readReadingPointer(window.localStorage); }
    catch { return { ...defaultReadingPointer }; }
  });
  useEffect(() => {
    const reload = (event: StorageEvent) => {
      if (event.key === readingPointerKey || event.key === null) {
        try { setSettings(readReadingPointer(window.localStorage)); } catch { /* Retain this tab's settings. */ }
      }
    };
    window.addEventListener("storage", reload);
    return () => window.removeEventListener("storage", reload);
  }, []);
  useEffect(() => {
    if (enabled && ready && host.current) return bindReadingPointer(host.current, settings);
  }, [host, enabled, ready, settings]);
  const update = (patch: Partial<ReadingPointerSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    try { saveReadingPointer(window.localStorage, next); }
    catch { notify("Reading pointer changed, but could not be saved on this device. It may reset when you reopen the app."); }
  };
  return { settings, update };
}

export function ReadingPointerControls({ settings, update }: {
  settings: ReadingPointerSettings;
  update: (patch: Partial<ReadingPointerSettings>) => void;
}) {
  const preview = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (preview.current) return bindReadingPointer(preview.current, settings, true);
  }, [settings]);
  const sliders = [
    ["size", "Pointer size", 16, 64, "px"],
    ["length", "Trail length", 40, 400, "px"],
    ["thickness", "Trail thickness", 2, 16, "px"],
    ["opacity", "Trail opacity", 20, 80, "%"],
    ["fade", "Trail fade duration", 150, 1000, "ms"],
  ] as const;
  return <section className="reading-pointer-settings" aria-label="Reading pointer">
    <h3>Reading pointer</h3>
    <p className="muted">Follow the text with your mouse. Saved for all PDFs on this device.</p>
    <label className="pin-controls"><input type="checkbox" checked={settings.pointer}
      onChange={e => update({ pointer: e.target.checked })} />Custom pointer</label>
    <label className="pin-controls"><input type="checkbox" checked={settings.trail}
      onChange={e => update({ trail: e.target.checked })} />Cursor trail</label>
    <div ref={preview} className="reading-pointer-preview">
      <span>Move your mouse here to try it</span>
      <p>One line at a time.<br />A little space to follow your thoughts.</p>
    </div>
    <label htmlFor="reading-pointer-shape">Pointer shape<select id="reading-pointer-shape" aria-label="Pointer shape" value={settings.shape} disabled={!settings.pointer}
      onChange={e => update({ shape: e.target.value as ReadingPointerSettings["shape"] })}>
      <option value="arrow">Arrow</option><option value="dot">Dot</option>
      <option value="ring">Hollow ring</option><option value="underline">Short underline</option>
    </select></label>
    <label className="reading-pointer-color">Pointer and trail color<input type="color" value={settings.color}
      disabled={!settings.pointer && !settings.trail} onChange={e => update({ color: e.target.value })} /></label>
    {sliders.map(([key, label, min, max, unit]) => <label key={key} htmlFor={`reading-pointer-${key}`} className="reading-pointer-slider">
      <span>{label}<output>{settings[key]} {unit}</output></span>
      <input id={`reading-pointer-${key}`} aria-label={label} type="range" min={min} max={max} value={settings[key]}
        disabled={key === "size" ? !settings.pointer : !settings.trail}
        onChange={e => update({ [key]: Number(e.target.value) })} />
    </label>)}
    <p className="muted">The guide pauses while selecting text or a region. Touch reading stays unchanged.</p>
    <button type="button" className="text-button" onClick={() => update({ ...defaultReadingPointer })}>Reset reading pointer</button>
  </section>;
}
