export type Format = "epub" | "pdf" | "docx";
export type Color = "yellow" | "green" | "blue" | "pink" | "purple";
export const colors: Record<Color, string> = {
  yellow: "#f4cc60",
  green: "#91cda4",
  blue: "#8abde8",
  pink: "#e8a2b6",
  purple: "#bb9add",
};
export type Quote = { exact: string; prefix: string; suffix: string };
export type Rect = [number, number, number, number];
export type Locator =
  | {
      v: 1;
      type: "epub";
      hash: string;
      cfi: string;
      href: string;
      quote?: Quote;
    }
  | {
      v: 1;
      type: "pdf";
      hash: string;
      page: number;
      y: number;
      point?: [number, number];
      regions?: { page: number; rects: Rect[] }[];
      quote?: Quote;
    }
  | {
      v: 1;
      type: "docx";
      hash: string;
      start: number;
      end: number;
      quote?: Quote;
    };
export type Book = {
  id: string;
  title: string;
  author: string;
  description: string;
  format: Format;
  filename: string;
  hash: string;
  bytes: number;
  cover?: string;
  tags: string[];
  status: "unread" | "reading" | "finished";
  addedAt: string;
  sourcePath: string;
  derivedPath?: string;
  purgedAt?: string;
};
export type Collection = { id: string; name: string };
export type Membership = { id: string; bookId: string; collectionId: string };
export type Annotation = {
  type?: "highlight" | "page-note";
  content?: { version: 1; document: RichNode };
  updatedAt?: string;
  id: string;
  bookId: string;
  locator: Locator;
  text: string;
  note: string;
  color: Color;
  tags: string[];
  createdAt: string;
};
export type Bookmark = {
  kind?: "place" | "passage";
  text?: string;
  id: string;
  bookId: string;
  locator: Locator;
  label: string;
  createdAt: string;
};
export type Position = {
  id: string;
  bookId: string;
  locator: Locator;
  progress: number;
  readAt: string;
  device: string;
};
export type ReadingSession = {
  id: string;
  bookId: string;
  start: number;
  end: number;
  device: string;
};
export type Preferences = {
  pdfLayout?: PdfLayout;
  id: string;
  theme: "light" | "sepia" | "dark";
  font: "Literata" | "Source Sans 3";
  fontSize: number;
  lineHeight: number;
  width: number;
  flow: "paginated" | "scrolled";
  spread: boolean;
};
export type PdfLayout = {
  columns: 1 | 2;
  navigation: "continuous" | "paginated";
  fit: "width" | "page";
};
export const defaultPdfLayout: PdfLayout = {
  columns: 1,
  navigation: "continuous",
  fit: "width",
};
export type RichNode = {
  type: string;
  text?: string;
  attrs?: Record<string, any>;
  marks?: { type: string }[];
  content?: RichNode[];
};
export const defaults: Preferences = {
  id: "reader",
  theme: "light",
  font: "Literata",
  fontSize: 20,
  lineHeight: 1.7,
  width: 760,
  flow: "scrolled",
  spread: false,
};
export interface EntityMap {
  book: Book;
  collection: Collection;
  membership: Membership;
  annotation: Annotation;
  bookmark: Bookmark;
  position: Position;
  session: ReadingSession;
  preferences: Preferences;
}
export type Kind = keyof EntityMap;
export type Entity = EntityMap[Kind];
export interface Row<T = Entity> {
  key: string;
  kind: Kind;
  id: string;
  value: T;
  revision: number;
  deleted: boolean;
  updatedAt: string;
  editedAt?: string;
  editId?: string;
}
export interface Operation {
  opId: string;
  key: string;
  kind: Kind;
  id: string;
  value: Entity;
  baseRevision: number;
  deleted: boolean;
  createdAt: string;
  sequence: number;
}
export interface Conflict {
  key: string;
  local: Row;
  remote: Row;
  detectedAt: string;
}
export interface BookFile {
  id: string;
  source: Blob;
  derived?: Blob;
  uploaded: boolean;
}
export const keyOf = (kind: Kind, id: string) => `${kind}:${id}`;
export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export const deviceId = () => {
  let id = localStorage.getItem("leafmark-device");
  if (!id) {
    id = uid();
    localStorage.setItem("leafmark-device", id);
  }
  return id;
};

// Sum the union of intervals, not their sum: two open readers must not double-count time.
export function readingSeconds(
  sessions: ReadingSession[],
  from = 0,
  to = Infinity,
): number {
  const ranges = sessions
    .map((s) => [Math.max(from, s.start), Math.min(to, s.end)])
    .filter((r) => r[1] > r[0])
    .sort((a, b) => a[0] - b[0]);
  let total = 0,
    end = 0;
  for (const [a, b] of ranges) {
    total += Math.max(0, b - Math.max(a, end));
    end = Math.max(end, b);
  }
  return Math.round(total / 1000);
}
