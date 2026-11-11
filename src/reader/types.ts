import type { Annotation, Locator, Preferences } from "../model";
export interface Section {
  id: string;
  label: string;
  children?: Section[];
}
export interface SearchHit {
  label: string;
  locator: Locator;
}
export interface Selection {
  locator: Locator;
  text: string;
}
export interface ReaderEvents {
  onPageNote?: (page: number) => void;
  onRegionMode?: (enabled: boolean) => void;
  onLayoutFallback?: (fallback: boolean) => void;
  onLocation: (locator: Locator, progress: number) => void;
  onSelection: (selection: Selection | null) => void;
  onAnnotation: (id: string) => void;
  onError: (message: string) => void;
}
export interface ReaderAdapter {
  open: (source: Blob, derived?: Blob) => Promise<void>;
  goTo: (locator: Locator | string) => Promise<void>;
  next: () => Promise<void>;
  previous: () => Promise<void>;
  search: (query: string) => Promise<SearchHit[]>;
  sections: () => Promise<Section[]>;
  configure: (preferences: Preferences) => void;
  annotate: (annotations: Annotation[]) => void;
  clearSelection: () => void;
  destroy: () => void;
}
