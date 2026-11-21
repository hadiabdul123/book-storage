/** Decode records across arbitrary UTF-8 and network chunk boundaries. */
export async function* readLines(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader(), decoder = new TextDecoder();
  let tail = "";
  try {
    while (true) {
      const {value, done} = await reader.read();
      tail += decoder.decode(value, {stream: !done});
      let end;
      while ((end = tail.indexOf("\n")) >= 0) {
        if (end > 64000) throw Error("Oversized stream record");
        yield tail.slice(0, end).trimEnd();
        tail = tail.slice(end + 1);
      }
      if (tail.length > 64000) throw Error("Oversized stream record");
      if (done) { if (tail) yield tail.trimEnd(); break; }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
