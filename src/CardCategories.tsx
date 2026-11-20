import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Dialog } from "./components";
import { cardLibrary, editCategory, fileCards } from "./cardStore";
import { save } from "./db";

export function CardCategories({ ids, close }: { ids: string[]; close: () => void }) {
  const data = useLiveQuery(cardLibrary, []);
  const [query, search] = useState(""), [changes, setChanges] = useState<Record<string, boolean>>({});
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  async function act(work: () => Promise<void>) {
    setBusy(true); setError("");
    try { await work(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <Dialog title={ids.length ? "File in categories" : "Manage categories"} onClose={close}>
    <label>Find or create a category<input type="search" autoFocus maxLength={80} value={query} onChange={e => search(e.target.value)} /></label>
    <div className="category-options">{data?.categories.filter(c => c.name.toLowerCase().includes(query.trim().toLowerCase())).map(c => {
      const filed = new Set(data.filings.filter(f => f.categoryId === c.id).map(f => f.cardId));
      const all = ids.length > 0 && ids.every(id => filed.has(id));
      return <div key={c.id}><label>{!!ids.length && <input type="checkbox" checked={changes[c.id] ?? all} ref={el => { if (el) el.indeterminate = changes[c.id] === undefined && !all && ids.some(id => filed.has(id)); }}
        onChange={e => setChanges({ ...changes, [c.id]: e.target.checked })} />}{c.name}</label>
        {!ids.length && <><button disabled={busy} onClick={() => { const name = prompt("Rename category", c.name); if (name) void act(async () => { await editCategory(name,c.id); }); }}>Rename</button>
        <button disabled={busy} onClick={() => { if (confirm("Delete this category? Its cards stay in your library.")) void act(async () => { await save("quote-category",c,true); }); }}>Delete</button></>}
      </div>;
    })}</div>
    {query.trim() && !data?.categories.some(c => c.name.toLowerCase() === query.trim().toLowerCase()) && <button disabled={busy} className="secondary" onClick={() => void act(async () => {
      const id = await editCategory(query); if (ids.length) setChanges(prev => ({ ...prev,[id]:true })); search("");
    })}>Create “{query.trim()}”</button>}
    {error && <p role="alert">{error}</p>}
    <button className="primary" disabled={busy || !data} onClick={() => void act(async () => { await fileCards(ids, changes); close(); })}>{ids.length ? "Save categories" : "Done"}</button>
  </Dialog>;
}
