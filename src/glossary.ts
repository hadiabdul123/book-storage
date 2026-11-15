import type { DictionaryEntry } from "./dictionary";

// Original explanatory paraphrases, rather than copied reference definitions.
// Context labels are deliberate: these terms have different theoretical uses.
const flowSource = {
  name: "Leafmark glossary · based on Mihaly Csikszentmihalyi, Flow, chapter 2",
  license: "Original explanation; reference book retains its copyright",
  url: "https://books.google.com/books?id=I6kQAQAAIAAJ",
};
const entries: DictionaryEntry[] = [
  {
    source: "glossary",
    word: "psychic energy",
    partOfSpeech: "noun phrase",
    context: "Flow / attention",
    attribution: flowSource,
    senses: [{
      definitions: ["The attention you can put into something. In Flow, directing this attention toward a goal is how you use your mental effort."],
      examples: ["When you concentrate on a book instead of checking your phone, you are putting your psychic energy into reading."],
      synonyms: ["attention", "mental effort"],
    }],
  },
  {
    source: "glossary",
    word: "psychic energy",
    partOfSpeech: "noun phrase",
    context: "Psychoanalytic theory",
    attribution: {
      name: "Leafmark glossary · based on APA Dictionary of Psychology",
      license: "Original explanation; reference definition retains its copyright",
      url: "https://dictionary.apa.org/psychic-energy",
    },
    senses: [{
      definitions: ["An idea used by Freud and Jung for the inner drive behind thoughts, feelings, and actions. Freud linked it to instincts; Jung also used it to describe personal and cultural development."],
      examples: ["A psychoanalytic writer might describe a strong wish to create art as psychic energy being directed into creative work."],
      synonyms: [],
    }],
  },
  {
    source: "glossary",
    word: "psychic entropy",
    partOfSpeech: "noun phrase",
    context: "Flow / attention",
    attribution: flowSource,
    senses: [{
      definitions: ["A state in which worries, distractions, or conflicting thoughts pull your attention away from what you want to do, making it hard to focus."],
      examples: ["You try to read, but thoughts about an unfinished task keep interrupting you. That scattered attention is an example of psychic entropy."],
      synonyms: ["scattered attention"],
    }],
  },
];

export function glossaryEntries(term: string) {
  return entries.filter((entry) => entry.word === term);
}
