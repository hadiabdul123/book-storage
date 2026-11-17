import { useSearchParams } from "react-router-dom";
import "./browse.css";
export function useBrowseState() {
  const [params, setParams] = useSearchParams();
  return {
    value: (key: string, fallback = "") => params.get(key) || fallback,
    update: (patch: Record<string, string>, replace = true) => setParams(previous => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(patch)) value ? next.set(key, value) : next.delete(key);
      return next;
    }, { replace }),
  };
}
export function pageOf<T>(items: T[], requested: string | number, size = 50) {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const page = Math.min(pages, Math.max(1, Math.floor(Number(requested)) || 1));
  return { items: items.slice((page - 1) * size, page * size), page, pages, total: items.length };
}
export function BrowsePages({ page, pages, total, onChange, label }: { page: number; pages: number; total: number; onChange: (page: number) => void; label: string }) {
  return <nav className="browse-pages" aria-label={`${label} pagination`}><span>{total} {label.toLowerCase()}{pages > 1 ? ` · Page ${page} of ${pages}` : ""}</span>{pages > 1 && <div><button disabled={page <= 1} onClick={() => onChange(page - 1)} aria-label={`Previous ${label.toLowerCase()} page`}>Previous</button><button disabled={page >= pages} onClick={() => onChange(page + 1)} aria-label={`Next ${label.toLowerCase()} page`}>Next</button></div>}</nav>;
}
export function SourceNavigator({ label, value, items, onChange, total }: { label: string; value: string; total?: number; items: { id: string; title: string; count: number; detail?: string }[]; onChange: (id: string) => void }) {
  return <details className="source-navigator" open><summary>{label}</summary><nav aria-label={label}><button aria-current={!value ? "page" : undefined} onClick={() => onChange("")}><span>All items</span><small>{total ?? items.reduce((n, i) => n + i.count, 0)}</small></button>{items.map(item => <button key={item.id} aria-current={value === item.id ? "page" : undefined} onClick={() => onChange(item.id)}><span>{item.title}{item.detail && <em>{item.detail}</em>}</span><small>{item.count}</small></button>)}</nav></details>;
}
