import type { Locator, RichNode } from "./model";
import type { BookComparison, ComparisonRequest } from "../supabase/functions/research/comparison";

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
export type Notebook = { id: string; title: string; createdAt: string; manualOrder?: number };
export type NotebookSection = { id: string; notebookId: string; title: string; order: number; createdAt: string };
export type NotebookNote = {
  sectionId?: string; order?: number;
  id: string; notebookId: string; title: string; document: RichNode;
  tags: string[]; createdAt: string; updatedAt: string;
};
export type ResearchMode = "explain" | "sources" | "web";
export type BookRange = { bookId: string; start: number; end: number; label: string };
export type ResearchScope = { ranges?: BookRange[]; bookIds: string[]; noteIds: string[]; highlightIds: string[] };
export type ResearchThread = {
  id: string; title: string; bookId?: string; notebookId?: string;
  scope?: ResearchScope;
  selection?: SourceRef; createdAt: string;
};
export type ResearchMessage = {
  id: string; threadId: string; question: string; mode: ResearchMode;
  answer: string; sources: SourceRef[]; createdAt: string; model: string;
  comparison?: BookComparison;
};
export type ResearchRequest = {
  meaning?: { term: string };
  comparison?: ComparisonRequest;
  requestId: string; mode: ResearchMode; question: string; searchQuery?: string;
  sources: SourceRef[]; history: { question: string; answer: string }[];
};
export type ResearchResult = { visualQuery?: string; answer: string; sources: SourceRef[]; model: string; comparison?: BookComparison };
export type ResearchJob = {
  id: string; threadId: string; request: ResearchRequest; cacheKey: string;
  state: "queued" | "running" | "done" | "error" | "cancelled" | "paused";
  createdAt: string; message?: string; retryAt?: number;
};
export type IndexedChunk = {
  id: string; bookId: string; hash: string; unit: number; text: string;
  locator: Locator; title: string;
};
