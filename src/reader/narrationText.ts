import { textNodes } from "../anchors";
import type { Locator } from "../model";

export type NarrationItem = { text: string; locator: Locator; missing?: boolean };
type Sentence = { text: string; start: number; end: number };
const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter("en", { granularity: "sentence" }) : undefined;

export function* narrationSentences(text: string, offset = 0): Generator<Sentence> {
  const segments = segmenter ? segmenter.segment(text) :
    [...text.matchAll(/[^.!?\n]+(?:[.!?]+|$)|[^\s]/g)].map(match => ({ index: match.index!, segment: match[0] }));
  for (const { index, segment } of segments) {
    const end = index + segment.length;
    let start = Math.max(index, offset);
    while (start < end) {
      let stop = Math.min(end, start + 320);
      if (stop < end) {
        const space = text.lastIndexOf(" ", stop);
        if (space > start + 60) stop = space + 1;
      }
      const part = text.slice(start, stop);
      const spoken = part.trim();
      if (spoken) yield { text: spoken.replace(/\s+/g, " "), start: start + part.length - part.trimStart().length, end: start + part.trimEnd().length };
      start = stop;
    }
  }
}

export function* documentNarration(root: HTMLElement, start = 0): Generator<Sentence> {
  let offset = 0, blockStart = 0, block: Element | undefined | null, text = "";
  const blockTags = "p,div,h1,h2,h3,h4,h5,h6,li,blockquote,td,th,pre";
  for (const node of textNodes(root)) {
    const parent = node.parentElement?.closest(blockTags);
    if (parent !== block) {
      for (const line of narrationSentences(text, Math.max(0, start - blockStart)))
        yield { ...line, start: line.start + blockStart, end: line.end + blockStart };
      block = parent; text = ""; blockStart = offset;
    }
    text += node.data; offset += node.length;
  }
  for (const line of narrationSentences(text, Math.max(0, start - blockStart)))
    yield { ...line, start: line.start + blockStart, end: line.end + blockStart };
}
