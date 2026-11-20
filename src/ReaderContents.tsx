import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { EpubCFI } from "epubjs";
import type { Locator } from "./model";
import type { Section } from "./reader/types";
import "./readerContents.css";

function compare(a: Locator, b: Locator) {
  if (a.hash !== b.hash) return undefined;
  if (a.type === "pdf" && b.type === "pdf") return a.page - b.page;
  if (a.type === "docx" && b.type === "docx") return a.start - b.start;
  if (a.type === "epub" && b.type === "epub") {
    try { return new EpubCFI().compare(a.cfi, b.cfi); }
    catch { return a.href === b.href ? 0 : undefined; }
  }
}

export function currentSection(sections: Section[], position?: Locator) {
  let best: { section: Section; key: string; depth: number; start: Locator } | undefined;
  let count = 0;
  function visit(items: Section[], parent: string, depth: number) {
    items.forEach((section, index) => {
      const key = `${parent}/${index}`;
      const start = section.start;
      if (section.id) count++;
      if (start && position && (compare(start, position) ?? Infinity) <= 0) {
        const later = best ? compare(start, best.start) ?? -1 : 1;
        if (!best || later > 0 || (later === 0 && depth > best.depth)) best = { section, key, depth, start };
      }
      if (section.children?.length) visit(section.children, key, depth + 1);
    });
  }
  visit(sections, "", 0);
  return { active: best, count };
}

export function ReaderContents({ sections, position, label, pages, loading, onGoTo }: {
  sections: Section[]; position?: Locator; label: string; pages?: number; loading: boolean;
  onGoTo: (target: string) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [number, setNumber] = useState("");
  const { active, count } = currentSection(sections, position);
  const current = useRef<HTMLButtonElement>(null);
  const scrolled = useRef(false);
  useEffect(() => {
    if (!scrolled.current && current.current) {
      scrolled.current = true;
      current.current.scrollIntoView({ block: "nearest" });
    }
  }, [active?.key]);

  function rows(items: Section[], parent = "") {
    return items.map((section, index) => {
      const key = `${parent}/${index}`;
      const isCurrent = active?.key === key;
      const hasChildren = !!section.children?.length;
      const open = expanded[key] ?? active?.key.startsWith(key + "/") ?? false;
      const page = section.start?.type === "pdf" ? section.start.page : undefined;
      return <li key={key}>
        <div className="contents-row">
          {section.id ? <button ref={isCurrent ? current : undefined} className="toc-item" aria-current={isCurrent ? "location" : undefined}
            onClick={() => onGoTo(section.id)}><span>{section.label}</span>{page && <small aria-label={`Starts on page ${page}`}>{page}</small>}</button>
            : <span className="contents-group-title">{section.label}</span>}
          {hasChildren && <button className="icon-button contents-expand" aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} ${section.label}`}
            onClick={() => setExpanded(prior => ({ ...prior, [key]: !open }))}><ChevronRight size={16} /></button>}
        </div>
        {hasChildren && open && <ul>{rows(section.children!, key)}</ul>}
      </li>;
    });
  }

  return <nav className="reader-contents" aria-label="Book contents">
    <div className="contents-location"><strong>{label}</strong>{count > 0 && <span>{count} {count === 1 ? "section" : "sections"}</span>}</div>
    {pages && <form className="contents-page-jump" onSubmit={event => {
      event.preventDefault();
      const page = Number(number);
      if (Number.isInteger(page) && page >= 1 && page <= pages) onGoTo(String(page));
    }}>
      <label>Go to page<input type="number" min={1} max={pages} step={1} required inputMode="numeric" value={number}
        placeholder={position?.type === "pdf" ? String(position.page) : "1"} onChange={event => setNumber(event.target.value)} /></label>
      <button className="secondary">Go</button>
    </form>}
    {loading ? <p role="status">Loading chapters…</p> : !!sections.length && <ul>{rows(sections)}</ul>}
  </nav>;
}
