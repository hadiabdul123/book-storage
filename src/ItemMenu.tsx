import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import { Dialog } from "./components";
import "./itemMenu.css";

export type ItemAction = { label: string; run: () => void; danger?: boolean; disabled?: boolean };

export function ItemMenu({ title, children, actions, className, touch = false, reorderId, grip, icon }: { title: string; children: ReactNode; actions: ItemAction[]; className?: string; touch?: boolean; reorderId?: string; grip?: ReactNode; icon?: ReactNode }) {
  const [point, setPoint] = useState<{ x: number; y: number }>();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const hold = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const finger = useRef<{ x: number; y: number } | undefined>(undefined);
  const suppressClick = useRef(false);
  function stopHold() { clearTimeout(hold.current); finger.current = undefined; }
  useEffect(() => stopHold, []);
  function open(x: number, y: number, focus: HTMLElement | null) {
    returnFocus.current = focus;
    setPoint({ x, y });
  }
  function close(restore = false) {
    setPoint(undefined);
    if (restore) returnFocus.current?.focus();
  }
  useLayoutEffect(() => {
    if (!point || !menu.current) return;
    const box = menu.current.getBoundingClientRect();
    menu.current.style.left = `${Math.max(8, Math.min(point.x, innerWidth - box.width - 8))}px`;
    menu.current.style.top = `${Math.max(8, Math.min(point.y, innerHeight - box.height - 8))}px`;
    menu.current.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [point]);
  useEffect(() => {
    if (!point) return;
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && event.target !== trigger.current) close(); };
    const leave = () => close();
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", leave);
    return () => { document.removeEventListener("pointerdown", outside, true); window.removeEventListener("resize", leave); };
  }, [point]);
  return <div data-reorder-id={reorderId} className={`workspace-item${className ? ` ${className}` : ""}`} onContextMenu={event => {
    event.preventDefault();
    if (event.currentTarget.hasAttribute("data-dragging") || (event.target as Element).closest(".reorder-grip")) return;
    stopHold();
    open(event.clientX, event.clientY, event.currentTarget.querySelector("button"));
  }} onPointerDown={event => {
    if (!touch || event.pointerType !== "touch" || !event.isPrimary || (event.target as Element).closest(".workspace-more, .workspace-menu")) return;
    const x = event.clientX, y = event.clientY;
    suppressClick.current = false; finger.current = { x, y };
    hold.current = setTimeout(() => { suppressClick.current = true; open(x, y, trigger.current); }, 520);
  }} onPointerMove={event => {
    const start = finger.current;
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) stopHold();
  }} onPointerCancel={stopHold} onPointerLeave={stopHold} onPointerUp={stopHold} onClickCapture={event => {
    if (!suppressClick.current || (event.target as Element).closest(".workspace-menu,.workspace-more")) return;
    suppressClick.current = false; event.preventDefault(); event.stopPropagation();
  }} onKeyDown={event => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    const box = event.currentTarget.getBoundingClientRect();
    open(box.left, box.bottom, event.target as HTMLElement);
  }}>
    {children}
    {grip}
    <button ref={trigger} type="button" className="workspace-more" aria-label={`More actions for ${title}`} aria-haspopup="menu" aria-expanded={!!point} onClick={event => {
      const box = event.currentTarget.getBoundingClientRect();
      if (point) close(); else open(box.right - 176, box.bottom, trigger.current);
    }}>{icon || <MoreHorizontal size={18} />}</button>
    {point && createPortal(<div ref={menu} className="workspace-menu" role="menu" aria-label={`Actions for ${title}`} onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); close(true); return; }
      if (event.key === "Tab") { close(true); return; }
      if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const buttons = Array.from(menu.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      if (!buttons.length) return;
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 :
        (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }}>
      {actions.map(action => <button key={action.label} type="button" role="menuitem" disabled={action.disabled} className={action.danger ? "danger" : undefined} onClick={() => { suppressClick.current = false; close(true); action.run(); }}>{action.label}</button>)}
    </div>, document.body)}
  </div>;
}

export function RenameItem({ value, label, onClose, onSave }: { value: string; label: string; onClose: () => void; onSave: (value: string) => Promise<unknown> }) {
  const [name, setName] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <Dialog title={`Rename ${label}`} onClose={onClose}>
    <form className="clip-form" onSubmit={async event => {
      event.preventDefault();
      if (!name.trim() || busy) return;
      setBusy(true); setError("");
      try { await onSave(name.trim()); onClose(); }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      finally { setBusy(false); }
    }}>
      <label>Name<input autoFocus required maxLength={150} value={name} onChange={event => setName(event.target.value)} /></label>
      {error && <p role="alert">{error}</p>}
      <button className="primary" disabled={busy || !name.trim()}>Save name</button>
    </form>
  </Dialog>;
}
