export const neuralVoices = [
  { id: "af_heart", name: "Heart", accent: "US English" },
  { id: "af_bella", name: "Bella", accent: "US English" },
  { id: "bm_george", name: "George", accent: "UK English" },
  { id: "am_michael", name: "Michael", accent: "US English" },
  { id: "bf_emma", name: "Emma", accent: "UK English" },
] as const;
export type NeuralVoice = typeof neuralVoices[number]["id"];
type AudioData = { samples: Float32Array<ArrayBuffer>; rate: number };
type AudioReply = { id: number; error?: string; progress?: number; samples?: Float32Array<ArrayBuffer>; rate?: number };

function wavUrl({ samples, rate }: AudioData) {
  const wav = new DataView(new ArrayBuffer(44 + samples.length * 2));
  wav.setUint32(0, 0x52494646); // RIFF
  wav.setUint32(4, wav.byteLength - 8, true);
  wav.setUint32(8, 0x57415645); // WAVE
  wav.setUint32(12, 0x666d7420); // fmt
  wav.setUint32(16, 16, true);
  wav.setUint16(20, 1, true);
  wav.setUint16(22, 1, true);
  wav.setUint32(24, rate, true);
  wav.setUint32(28, rate * 2, true);
  wav.setUint16(32, 2, true);
  wav.setUint16(34, 16, true);
  wav.setUint32(36, 0x64617461); // data
  wav.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    wav.setInt16(44 + index * 2, sample * (sample < 0 ? 32768 : 32767), true);
  }
  return URL.createObjectURL(new Blob([wav.buffer], { type: "audio/wav" }));
}

async function waitForAudioAccess(play: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([play, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Audio did not start. Tap Retry sentence to enable playback.")), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}

export class NarrationAudio {
  private clips = new Map<string, AudioData>();
  private clipBytes = 0;

  private worker?: Worker;
  private context?: AudioContext;
  private source?: AudioBufferSourceNode;
  private media?: HTMLAudioElement;
  private mediaUrl?: string;
  private speech?: SpeechSynthesisUtterance;
  private id = 0;
  private pending = new Map<number, { resolve: (audio: AudioData) => void; reject: (error: Error) => void; progress: (value: number) => void }>();
  private watchdog?: ReturnType<typeof setTimeout>;
  private watchWorker() {
    clearTimeout(this.watchdog);
    if (this.pending.size) this.watchdog = setTimeout(() => {
      this.closeWorker("The voice stopped responding. Retry this sentence or choose an installed voice.");
    }, 90_000);
  }

  unlock() {
    const Context = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Context) {
      this.context ??= new Context();
      return waitForAudioAccess(this.context.resume());
    }
    this.media ??= new Audio();
    this.media.src = this.mediaUrl = wavUrl({ samples: new Float32Array(800), rate: 8000 });
    return waitForAudioAccess(this.media.play());
  }

  generate(text: string, voice: string, speed: number, progress: (value: number) => void) {
    const key = JSON.stringify([voice, speed, text]);
    const clip = this.clips.get(key);
    if (clip) {
      this.clips.delete(key);
      this.clips.set(key, clip);
      return Promise.resolve(clip);
    }
    if (!this.worker) {
      this.worker = new Worker(new URL("./narration.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = ({ data }: MessageEvent<AudioReply>) => {
        const next = this.pending.get(data.id);
        if (!next) return;
        if (data.progress !== undefined) { this.watchWorker(); next.progress(data.progress); return; }
        this.pending.delete(data.id);
        this.watchWorker();
        if (data.samples && data.rate) next.resolve({ samples: data.samples, rate: data.rate });
        else next.reject(new Error(data.error || "The voice could not generate audio."));
      };
      this.worker.onerror = this.worker.onmessageerror = () => this.closeWorker("Could not load the narration engine. Retry or choose an installed voice.");
    }
    const id = ++this.id;
    return new Promise<AudioData>((resolve, reject) => {
      this.pending.set(id, { reject, progress, resolve: audio => {
        this.remember(key, audio);
        resolve(audio);
      } });
      if (this.pending.size === 1) this.watchWorker();
      this.worker!.postMessage({ id, text, voice, speed });
    });
  }

  private remember(key: string, audio: AudioData) {
    const budget = 6 * 1024 * 1024;
    if (audio.samples.byteLength > budget) return;
    this.clipBytes -= this.clips.get(key)?.samples.byteLength ?? 0;
    this.clips.delete(key);
    this.clips.set(key, audio);
    this.clipBytes += audio.samples.byteLength;
    for (const [oldest, clip] of this.clips) {
      if (this.clipBytes <= budget) break;
      this.clips.delete(oldest);
      this.clipBytes -= clip.samples.byteLength;
    }
  }

  async speak(data: AudioData, onEnd: () => void) {
    if (this.media) {
      this.releaseMedia();
      const url = this.mediaUrl = wavUrl(data);
      this.media.src = url;
      this.media.onended = () => {
        if (this.mediaUrl !== url) return;
        this.releaseMedia();
        onEnd();
      };
      await waitForAudioAccess(this.media.play());
      return;
    }
    const context = this.context;
    if (!context) throw new Error("Start narration to enable audio on this device.");
    const buffer = context.createBuffer(1, data.samples.length, data.rate);
    buffer.copyToChannel(data.samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = () => { source.disconnect(); if (this.source === source) { this.source = undefined; onEnd(); } };
    this.source = source;
    source.start();
  }

  speakWithDevice(text: string, voice: SpeechSynthesisVoice, rate: number, onEnd: () => void, onError: (message: string) => void) {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = voice;
    utterance.rate = rate;
    utterance.onend = () => { if (this.speech === utterance) { this.speech = undefined; onEnd(); } };
    utterance.onerror = () => { if (this.speech === utterance) { this.speech = undefined; onError("The installed voice could not play this sentence."); } };
    this.speech = utterance;
    speechSynthesis.resume();
    speechSynthesis.speak(utterance);
  }

  pause() {
    if (this.speech) speechSynthesis.pause();
    if (this.source) void this.context?.suspend().catch(() => {});
    if (this.mediaUrl) this.media?.pause();
  }

  async resume() {
    if (this.speech) speechSynthesis.resume();
    if (this.source) await this.context?.resume();
    if (this.mediaUrl) await this.media?.play();
  }

  private releaseMedia() {
    if (!this.media || !this.mediaUrl) return;
    this.media.onended = null;
    this.media.pause();
    this.media.removeAttribute("src");
    URL.revokeObjectURL(this.mediaUrl);
    this.mediaUrl = undefined;
  }

  halt() {
    const source = this.source;
    this.source = undefined;
    if (source) { source.onended = null; source.stop(); source.disconnect(); }
    if (this.speech) { this.speech = undefined; speechSynthesis.cancel(); }
    this.releaseMedia();
  }

  cancelPending() {
    // Keep the initialized model for another play from the same book. An
    // outstanding download or synthesis job still stops when cancelled.
    if (this.pending.size) this.closeWorker();
  }

  closeWorker(message = "Narration stopped.") {
    clearTimeout(this.watchdog);
    this.worker?.terminate();
    this.worker = undefined;
    for (const { reject } of this.pending.values()) reject(new Error(message));
    this.pending.clear();
  }

  destroy() {
    this.halt();
    this.closeWorker();
    this.clips.clear();
    this.clipBytes = 0;
    void this.context?.close().catch(() => {});
    this.context = undefined;
  }
}
