import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Pause, Play, SkipBack, SkipForward, Square } from "lucide-react";
import { db } from "./db";
import type { Book, Locator } from "./model";
import { NarrationAudio, neuralVoices } from "./reader/narrationAudio";
import type { NarrationItem } from "./reader/narrationText";
import type { ReaderAdapter, ScreenRect } from "./reader/types";
import { validLocator } from "./validation";
import "./readAlong.css";

type Settings = { voice: string; speed: number; follow: boolean };
type Status = "idle" | "buffering" | "playing" | "paused" | "missing" | "complete" | "error";
type Session = {
  abort: AbortController; source: AsyncGenerator<NarrationItem>; items: Map<number, NarrationItem>;
  next: number; ended: boolean; loading?: Promise<void>;
  cached: Map<string, ReturnType<NarrationAudio["generate"]>>;
};
const defaultSettings: Settings = { voice: "af_heart", speed: 1, follow: true };
const settingsKey = "narration-settings:v1";
const keyFor = (book: Book) => `narration-position:${book.id}:${book.hash}`;

async function itemAt(session: Session, index: number) {
  while (session.next <= index && !session.ended && !session.abort.signal.aborted) {
    session.loading ??= session.source.next().then(item => {
      if (item.done) session.ended = true;
      else session.items.set(session.next++, item.value);
    }).finally(() => { session.loading = undefined; });
    await session.loading;
  }
  return session.items.get(index);
}

function SpokenHighlight({ item, reader, host }: { item: NarrationItem; reader: ReaderAdapter | null; host: HTMLElement | null }) {
  const [rects, setRects] = useState<ScreenRect[]>([]);
  useEffect(() => {
    if (!reader || !host) return;
    let frame = 0;
    const update = () => {
      const viewport = host.getBoundingClientRect();
      setRects(reader.bounds(item.locator).map(rect => ({
        left: Math.max(rect.left, viewport.left), top: Math.max(rect.top, viewport.top),
        right: Math.min(rect.right, viewport.right), bottom: Math.min(rect.bottom, viewport.bottom),
      })).filter(rect => rect.right > rect.left && rect.bottom > rect.top));
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule);
    observer.observe(host);
    host.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); host.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [reader, host, item.locator]);
  return <div className="narration-layer" aria-hidden="true">{rects.map((rect, index) =>
    <span key={index} style={{ left: rect.left, top: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top }} />)}</div>;
}

export function ReadAlong({ book, adapter, host, controls, start, selected }: {
  book: Book; adapter: RefObject<ReaderAdapter | null>; host: RefObject<HTMLElement | null>; controls: HTMLElement | null;
  start?: Locator; selected: boolean;
}) {
  const [settings, setSettings] = useState(defaultSettings);
  const preferences = useRef(settings);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [saved, setSaved] = useState<Locator>();
  const [part, setPart] = useState<NarrationItem>();
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const [download, setDownload] = useState<number>();
  const [preparing, setPreparing] = useState(false);
  const audio = useRef<NarrationAudio | undefined>(undefined);
  const session = useRef<Session | undefined>(undefined);
  const request = useRef(0);
  const changed = useRef(false);
  const devices = useRef<SpeechSynthesisVoice[]>([]);
  const cursor = useRef(0);
  const pauseRequested = useRef(false);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      devices.current = window.speechSynthesis?.getVoices().filter(voice => voice.localService) || [];
      setVoices(devices.current);
    };
    refresh();
    window.speechSynthesis?.addEventListener("voiceschanged", refresh);
    void Promise.all([db.meta.get(settingsKey), db.meta.get(keyFor(book))]).then(([configuration, resume]) => {
      if (!active) return;
      if (!changed.current && configuration) {
        const value: Partial<Settings> = JSON.parse(configuration.value);
        const next = { voice: typeof value.voice === "string" ? value.voice : defaultSettings.voice,
          speed: typeof value.speed === "number" && value.speed >= .75 && value.speed <= 2.5 ? value.speed : 1,
          follow: typeof value.follow === "boolean" ? value.follow : true };
        preferences.current = next; setSettings(next);
      }
      if (resume) {
        const value: unknown = JSON.parse(resume.value);
        if (validLocator(value) && value.hash === book.hash) setSaved(value);
      }
    }).catch(() => {});
    return () => {
      active = false; request.current++;
      session.current?.abort.abort();
      void session.current?.source.return(undefined).catch(() => {});
      audio.current?.destroy();
      window.speechSynthesis?.removeEventListener("voiceschanged", refresh);
    };
  }, [book.id, book.hash]);

  function cancel() {
    request.current++;
    const previous = session.current;
    session.current = undefined;
    previous?.abort.abort();
    void previous?.source.return(undefined).catch(() => {});
    audio.current?.halt();
    audio.current?.cancelPending();
    setPart(undefined); setDownload(undefined);
  }

  function fail(error: unknown) {
    setDownload(undefined);
    setStatus("error");
    setMessage(error instanceof Error ? error.message : String(error));
  }

  function buffer(current: Session, item: NarrationItem, at: number, config: Settings, token: number) {
    const key = `${at}:${config.voice}:${config.speed}`;
    const exists = current.cached.get(key);
    if (exists) return exists;
    const result = audio.current!.generate(item.text, config.voice, config.speed, percent => {
      if (request.current === token) setDownload(percent < 100 ? percent : undefined);
    });
    current.cached.set(key, result);
    void result.catch(() => current.cached.delete(key));
    return result;
  }

  function play(at: number, unlock = false) {
    const current = session.current;
    const reader = adapter.current;
    if (!current || !reader || at < 0) return;
    const engine = audio.current ??= new NarrationAudio();
    const config = preferences.current;
    const token = ++request.current;
    const playing = () => token === request.current && current === session.current;
    const device = config.voice.startsWith("device:");
    engine.halt();
    // Request audio access while the start/skip button still holds user activation.
    let access: Promise<void> | undefined;
    if (!device && unlock) {
      try { access = engine.unlock(); void access.catch(() => {}); }
      catch (cause) { fail(cause); return; }
    }
    pauseRequested.current = false;
    cursor.current = at;
    setIndex(at); setStatus("buffering"); setMessage(""); setDownload(undefined);
    if (!current.items.has(at)) setPart(undefined);

    void (async () => {
      await access;
      const item = await itemAt(current, at);
      if (!playing()) return;
      if (!item) { setPart(undefined); setStatus("complete"); return; }
      if (item.missing) { setPart(item); setStatus("missing"); return; }
      const voice = device ? devices.current.find(v => `device:${v.voiceURI}` === config.voice) : undefined;
      if (device && !voice) throw new Error("Choose an installed voice available on this device.");
      const samples = !device ? await buffer(current, item, at, config, token) : undefined;
      if (!playing()) return;
      // Generate ahead while this sentence plays. A slow next page (including
      // OCR or model inference) must never hold back audio already available.
      if (!device) void itemAt(current, at + 1).then(part =>
        playing() && part && !part.missing ? buffer(current, part, at + 1, config, token) : undefined
      ).catch(() => {});
      if (preferences.current.follow) {
        const viewport = host.current?.getBoundingClientRect();
        const top = viewport?.top ?? 0;
        if (!viewport || !reader.bounds(item.locator).some(rect => rect.top >= top && rect.bottom <= viewport.bottom - 64))
          void reader.goTo(item.locator).catch(() => {});
      }
      if (!playing()) return;
      setPart(item); setSaved(item.locator); setDownload(undefined);
      void db.meta.put({ key: keyFor(book), value: JSON.stringify(item.locator) }).catch(() => {});
      if (samples) await engine.speak(samples, () => { if (playing()) play(at + 1); });
      else if (voice) engine.speakWithDevice(item.text, voice, config.speed, () => {
        if (playing()) play(at + 1);
      }, error => { if (playing()) fail(error); });
      if (!playing()) return;
      if (pauseRequested.current) engine.pause();
      setStatus(pauseRequested.current ? "paused" : "playing");
      for (const number of current.items.keys()) if (number < at - 8) current.items.delete(number);
      for (const key of current.cached.keys()) if (Number(key.split(":", 1)[0]) < at - 2) current.cached.delete(key);
    })().catch(error => { if (playing()) fail(error); });
  }

  function begin(locator = start) {
    const reader = adapter.current;
    if (!reader) return;
    cancel();
    const abort = new AbortController();
    session.current = { abort, source: reader.narration(locator, abort.signal), items: new Map(), cached: new Map(), next: 0, ended: false };
    play(0, true);
  }

  function change(next: Settings) {
    preferences.current = next; changed.current = true;
    setSettings(next);
    void db.meta.put({ key: settingsKey, value: JSON.stringify(next) }).catch(() => {});
  }

  function preview() {
    const voice = voices.find(candidate => `device:${candidate.voiceURI}` === settings.voice);
    if (!voice) return;
    audio.current ??= new NarrationAudio();
    audio.current.halt();
    audio.current.speakWithDevice("The best stories stay with us long after the last page.", voice, settings.speed, () => {}, fail);
  }

  const active = status !== "idle" && status !== "complete";
  const paused = status === "paused";
  const playing = status === "playing";
  const deviceVoice = settings.voice.startsWith("device:");
  const instantVoice = voices.find(v => /^en(?:-|$)/i.test(v.lang) && v.default)
    || voices.find(v => /^en(?:-|$)/i.test(v.lang)) || voices.find(v => v.default) || voices[0];
  function playInstalled() {
    if (!instantVoice) return;
    const next = { ...preferences.current, voice: "device:" + instantVoice.voiceURI };
    change(next);
    if (session.current && status !== "complete") {
      request.current++;
      audio.current?.cancelPending();
      play(cursor.current, true);
    } else begin();
  }
  const ui = <div className="read-along">
    <label>Voice<select aria-label="Voice" value={settings.voice} onChange={event => {
      if (active) { cancel(); setStatus("idle"); }
      change({ ...settings, voice: event.target.value });
    }}>
      <optgroup label="On-device Kokoro">{neuralVoices.map(voice =>
        <option key={voice.id} value={voice.id}>{voice.name} · {voice.accent}</option>)}</optgroup>
      {!!voices.length && <optgroup label="Installed device voices">{voices.map(voice =>
        <option key={voice.voiceURI} value={`device:${voice.voiceURI}`}>{voice.name} · {voice.lang}</option>)}</optgroup>}
    </select></label>
    {deviceVoice ? <button className="text-button" disabled={active} onClick={preview}>Preview voice</button>
      : !active && neuralVoices.some(voice => voice.id === settings.voice) && <audio
        key={settings.voice} controls preload="none" aria-label="Preview Kokoro voice"
        src={`${import.meta.env.BASE_URL}voice-previews/${settings.voice}.wav`} />}
    {!deviceVoice && status === "idle" && <p>First use downloads the 90 MB model and its runtime. Leafmark generates speech on this device.</p>}
    {!deviceVoice && instantVoice && ["idle", "complete", "buffering", "error"].includes(status) &&
      <button className="text-button" onClick={playInstalled}>Play now with {instantVoice.name}</button>}
    <label>Playback speed<select value={settings.speed} onChange={event => {
      const next = { ...settings, speed: Number(event.target.value) };
      change(next);
      if (playing || status === "buffering") play(cursor.current, true);
      else if (paused) { audio.current?.halt(); pauseRequested.current = true; }
    }}>{[.75, 1, 1.15, 1.25, 1.5, 1.75, 2, 2.25, 2.5].map(speed => <option key={speed} value={speed}>{speed}×</option>)}</select></label>
    <label className="narration-follow"><input type="checkbox" checked={settings.follow} onChange={event => change({ ...settings, follow: event.target.checked })} />Follow the narration on the page</label>
    {!active && <div className="narration-actions">
      <button className="primary" onClick={() => begin()}><Play size={17} />{selected ? "Play from selection" : "Play from here"}</button>
      {saved && <button className="secondary" onClick={() => begin(saved)}>Resume listening</button>}
    </div>}
    {active && <div className="narration-actions">
      <button className="icon-button" aria-label="Previous sentence" disabled={index === 0 || !session.current?.items.has(index - 1)} onClick={() => play(index - 1, true)}><SkipBack size={19} /></button>
      {(playing || paused || status === "buffering") && <button className="secondary" onClick={() => {
        if (paused) {
          if (pauseRequested.current) play(cursor.current, true);
          else { void audio.current?.resume().then(() => setStatus("playing"), fail); }
        } else if (status === "buffering") {
          request.current++; audio.current?.halt(); pauseRequested.current = true; setStatus("paused");
        }
        else { audio.current?.pause(); setStatus("paused"); }
      }}>{paused ? <><Play size={17} />Resume</> : <><Pause size={17} />Pause</>}</button>}
      <button className="icon-button" aria-label="Next sentence" disabled={preparing} onClick={() => play(index + 1, true)}><SkipForward size={19} /></button>
      <button className="icon-button" aria-label="Stop narration" onClick={() => { cancel(); setStatus("idle"); }}><Square size={17} /></button>
    </div>}
    {part && !part.missing && <blockquote>{part.text}</blockquote>}
    {status === "buffering" && <p role="status">{download === undefined ? (deviceVoice ? "Opening device voice…" : index === 0 ? "Preparing the first sentence…" : "Preparing the next sentence…") : `Downloading Kokoro · ${download}%`}</p>}
    {status === "complete" && <p role="status">You reached the end of the book.</p>}
    {status === "error" && <div><p role="alert">{message}</p><button className="secondary" onClick={() => session.current ? play(cursor.current, true) : begin()}>Retry sentence</button></div>}
    {status === "missing" && part?.locator.type === "pdf" && <div>
      <p role="status">Page {part.locator.page} has no prepared text.</p>
      <div className="narration-actions"><button className="secondary" disabled={preparing} onClick={async () => {
        const token = request.current;
        setPreparing(true); setMessage("");
        try {
          await adapter.current?.prepareNarration?.(part.locator);
          if (request.current === token) begin(part.locator);
        } catch (error) { if (request.current === token) setMessage(error instanceof Error ? error.message : String(error)); }
        finally { setPreparing(false); }
      }}>{preparing ? "Preparing text…" : "Prepare text"}</button>
      <button className="text-button" disabled={preparing} onClick={() => play(index + 1, true)}>Skip page</button></div>
      {message && <p role="alert">{message}</p>}
    </div>}
  </div>;

  return <>
    {controls && createPortal(ui, controls)}
    {part && !part.missing && <SpokenHighlight item={part} reader={adapter.current} host={host.current} />}
  </>;
}
