import { useState } from "react";

export type BoardCard = { id: string; title: string; subtitle: string; text: string };
type Collection = { id: string; name: string };
type Props = {
  collections: Collection[];
  groups: Map<string, BoardCard[]>;
  selected: string[];
  comparison?: [string, string];
  compare: (left: string, right: string) => void;
  open: (id: string, trigger: HTMLButtonElement) => void;
  checked?: string[];
};

function Slips({ cards, open, checked, initial = 12 }: Pick<Props, "open" | "checked"> & { cards: BoardCard[]; initial?: number }) {
  const [limit, setLimit] = useState(initial);
  return <><div className="board-slips">{cards.slice(0, limit).map(card =>
    <button type="button" key={card.id} aria-pressed={checked && checked.includes(card.id)} onClick={event => open(card.id, event.currentTarget)}>
      <small>{card.title} · {card.subtitle}</small><span>{card.text}</span>
    </button>)}</div>
    {!cards.length && <p className="muted">No highlights in this collection.</p>}
    {cards.length > limit && <button className="text-button" onClick={() => setLimit(limit + 24)}>Show more highlights ({cards.length - limit})</button>}
  </>;
}

export function CollectionBoard({ collections, groups, selected, comparison, compare, open, checked }: Props) {
  const [tab, setTab] = useState(0);
  if (comparison) return <section className="comparison" aria-label="Compare collections">
    <div className="compare-tabs" aria-label="Visible collection">{comparison.map((id, index) =>
      <button key={index} aria-pressed={tab === index} onClick={() => setTab(index)}>{collections.find(c => c.id === id)?.name}</button>)}</div>
    <div className="compare-columns">{comparison.map((id, index) => {
      const cards = groups.get(id) || [];
      return <section key={index} className="compare-column" data-active={tab === index} aria-label={index ? "Right collection" : "Left collection"}>
        <header><select aria-label={index ? "Choose right collection" : "Choose left collection"} value={id} onChange={e => index ? compare(comparison[0], e.target.value) : compare(e.target.value, comparison[1])}>
          {collections.map(c => <option key={c.id} value={c.id} disabled={comparison[1-index] === c.id}>{c.name}</option>)}
        </select><small>{cards.length} {cards.length === 1 ? "highlight" : "highlights"}</small></header>
        <div className="compare-scroll" key={id}><Slips cards={cards} open={open} checked={checked}/></div>
      </section>;
    })}</div></section>;
  const visible = collections.filter(c => selected.length ? selected.includes(c.id) : groups.has(c.id));
  return <div className="collection-overview" aria-label="Collection board">
    {visible.map(c => <section key={c.id}><h2>{c.name}<small>{groups.get(c.id)?.length || 0} {groups.get(c.id)?.length === 1 ? "highlight" : "highlights"}</small></h2>
      <Slips cards={groups.get(c.id) || []} open={open} checked={checked} initial={selected.length ? 12 : 4}/></section>)}
    {!visible.length && <p className="notice">No highlights here yet. Highlight a passage in a book or change your filters.</p>}
  </div>;
}
