import type { SourceRef } from "./researchTypes";

export function ResearchAnswer({ text, sources, prefix, onInspect }: {
  text: string; sources: SourceRef[]; prefix: string; onInspect?: (source: SourceRef) => void;
}) {
  return <>{text.split(/\n\s*\n/).map((paragraph, i) => <p key={i}>{paragraph.split(/(\[S\d+\])/g).map((part, n) => {
    const source = sources.find(item => `[${item.id}]` === part);
    if (!source) return <span key={n}>{part}</span>;
    return <sup key={n}><a href={`#research-source-${prefix}-${source.id}`} title={source.title} onClick={event => {
      event.preventDefault();
      if (onInspect) { onInspect(source); return; }
      const target = document.getElementById(`research-source-${prefix}-${source.id}`);
      const details = target?.closest("details");
      if (details) details.open = true;
      target?.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    }}>{part}</a></sup>;
  })}</p>)}</>;
}
