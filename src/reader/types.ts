import type { Annotation, Locator, Preferences } from "../model";
import type { NarrationItem } from "./narrationText";
export interface Section {
  id: string;
  label: string;
  start?: Locator;
  children?: Section[];
}
export interface SearchHit {
  label: string;
  locator: Locator;
}
export interface Selection {
  kind?: "image";
  locator: Locator;
  text: string;
}
export type SelectionSource = "native" | "touch";
export type ScreenRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};
export interface ReaderEvents {
  onSelectionInteraction?: (adjusting: boolean) => void;
  onMouseSelection?: (dragging: boolean) => void;
  canEdgeTurn?: () => boolean;
  onReaderTap?: () => void;
  onZoom?: (zoom: number) => void;
  canSwipe?: () => boolean;
  canPrepare?: () => boolean;
  canDragTurn?: () => boolean;
  onReaderSwipe?: (direction: "next" | "previous") => void;
  onShortcut?: (event: KeyboardEvent) => void;
  onPageNote?: (page: number) => void;
  onRegionMode?: (enabled: boolean) => void;
  onLayoutFallback?: (fallback: boolean) => void;
  onPageCount?: (total: number) => void;
  onTextBoxLayout?: () => void;
  onLocation: (locator: Locator, progress: number) => void;
  onSelection: (selection: Selection | null, source?: SelectionSource) => void;
  onAnnotation: (id: string) => void;
  onBookImage?: (file: File, locator: Locator, label: string) => void;
  onHint?: (message: string) => void;
  onError: (message: string) => void;
}
export interface ReaderAdapter {
  context: (selection: Selection) => Promise<string>;
  bounds: (locator: Locator) => ScreenRect[];
  intersects: (a: Locator, b: Locator) => boolean;
  open: (source: Blob, derived?: Blob) => Promise<void>;
  goTo: (locator: Locator | string) => Promise<void>;
  next: () => Promise<void>;
  previous: () => Promise<void>;
  search: (query: string) => Promise<SearchHit[]>;
  sections: () => Promise<Section[]>;
  narration: (start: Locator | undefined, signal: AbortSignal) => AsyncGenerator<NarrationItem>;
  prepareNarration?: (locator: Locator) => Promise<void>;
  configure: (preferences: Preferences) => void;
  annotate: (annotations: Annotation[]) => void;
  hasSelection: () => boolean;
  clearSelection: () => void;
  destroy: () => void;
}
