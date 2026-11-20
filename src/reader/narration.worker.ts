import { KokoroTTS } from "kokoro-js";

type Request = { id: number; text: string; voice: keyof KokoroTTS["voices"]; speed: number };
let model: Promise<KokoroTTS> | undefined;
let queue = Promise.resolve();
const worker = self as unknown as { postMessage: (value: unknown, transfer?: Transferable[]) => void };

self.addEventListener("message", ({ data }: MessageEvent<Request>) => {
  queue = queue.then(async () => {
    const { id, text, voice, speed } = data;
    try {
      model ??= KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
        device: "wasm", dtype: "q8", progress_callback: event => {
          if (event.status === "progress" && event.file.endsWith(".onnx")) {
            worker.postMessage({ id, progress: Math.min(100, Math.round(event.progress)) });
          }
        },
      }).catch(error => { model = undefined; throw error; });
      const audio = await (await model).generate(text, { voice, speed });
      const samples = new Float32Array(audio.audio);
      worker.postMessage({ id, samples, rate: audio.sampling_rate }, [samples.buffer]);
    } catch (error) {
      worker.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
  });
});
