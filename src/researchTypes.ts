import type { Locator, RichNode } from "./model";

export type SourceRef = {
  id: string;
  kind: "book" | "note" | "web";
  title: string;
  excerpt: string;
  bookId?: string;
  annotationId?: string;
  locator?: Locator;
  noteId?: string;
  url?: string;
  retrievedAt?: string;
};
export type Notebook = { id: string; title: string; createdAt: string };
export type NotebookSection = { id: string; notebookId: string; title: string; order: number; createdAt: string };
export type NotebookNote = {
  sectionId?: string; order?: number;
  id: string; notebookId: string; title: string; document: RichNode;
  tags: string[]; createdAt: string; updatedAt: string;
};
export type ResearchMode = "explain" | "sources" | "web";
export type ResearchScope = { bookIds: string[]; noteIds: string[]; highlightIds: string[] };
export type ResearchThread = {
  id: string; title: string; bookId?: string; notebookId?: string;
  scope?: ResearchScope;
  selection?: SourceRef; createdAt: string;
};
export type ResearchMessage = {
  id: string; threadId: string; question: string; mode: ResearchMode;
  answer: string; sources: SourceRef[]; createdAt: string; model: string;
};
export type ResearchRequest = {
  meaning?: { term: string };
  requestId: string; mode: ResearchMode; question: string; searchQuery?: string;
  sources: SourceRef[]; history: { question: string; answer: string }[];
};
export type ResearchResult = { answer: string; sources: SourceRef[]; model: string };
export type ResearchJob = {
  id: string; threadId: string; request: ResearchRequest; cacheKey: string;
  state: "queued" | "running" | "done" | "error" | "cancelled" | "paused";
  createdAt: string; message?: string; retryAt?: number;
};
export type IndexedChunk = {
  id: string; bookId: string; hash: string; unit: number; text: string;
  locator: Locator; title: string;
};
