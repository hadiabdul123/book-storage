import { useEffect, useRef, useState, type RefObject } from "react";
import { bindReadingTaps } from "./reader/gestures";
const key = "leafmark-controls-pinned";
const idleDelay = 2000;
const leaveDelay = 750;
export function useReaderChrome(
  shell: RefObject<HTMLElement | null>,
  host: RefObject<HTMLDivElement | null>,
  ready: number,
  locked: boolean,
  immersive = false,
  edgeOnly = false,
) {
  const [pinned, setPinnedState] = useState(() => {
    try {
      return localStorage.getItem(key) === "true";
    } catch {
      return false;
    }
  });
  const [visible, setVisible] = useState(false);
  const [menu, setMenu] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const effectivePinned = pinned && !immersive;
  const current = useRef({ locked, pinned: effectivePinned, menu });
  current.current = { locked, pinned: effectivePinned, menu };
  const heldOpen = () =>
    current.current.locked ||
    current.current.pinned ||
    current.current.menu;
  const protectedNow = () =>
    heldOpen() ||
    (window.matchMedia("(hover: hover)").matches &&
      !!shell.current?.querySelector(
        ".reader-header:hover,.reader-footer:hover,.reader-reveal:hover",
      )) ||
    !!shell.current?.querySelector(".passage-popup") ||
    !!shell.current?.querySelector(
      ".reader-reveal:focus-visible,.reader-header :focus-visible,.reader-footer :focus-visible",
    );
  const hideLater = (delay = idleDelay) => {
    clearTimeout(hideTimer.current);
    if (heldOpen()) return;
    hideTimer.current = setTimeout(() => {
      if (protectedNow()) hideLater();
      else setVisible(false);
    }, delay);
  };
  const reveal = () => {
    setVisible(true);
    hideLater();
  };
  const toggle = () => {
    if (current.current.menu && !current.current.locked) {
      setMenu(false);
      setVisible(false);
      return;
    }
    if (!protectedNow()) setVisible((v) => !v);
  };
  const tap = useRef(toggle);
  tap.current = toggle;
  const setPinned = (value: boolean) => {
    setPinnedState(value);
    try {
      localStorage.setItem(key, String(value));
    } catch {}
    if (value) setVisible(true);
  };
  useEffect(() => {
    if (!host.current || edgeOnly) return;
    return bindReadingTaps(host.current, () => tap.current());
  }, [ready, host, edgeOnly]);
  useEffect(() => {
    if (visible) hideLater();
    return () => clearTimeout(hideTimer.current);
  }, [visible, locked, effectivePinned, menu]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        current.current.locked ||
        current.current.pinned ||
        shell.current?.querySelector(".passage-popup")
      )
        return;
      if (
        (event.target as Element)?.closest("input,textarea,[contenteditable]")
      )
        return;
      setMenu(false);
      setVisible(false);
      if (shell.current?.contains(document.activeElement))
        (document.activeElement as HTMLElement)?.blur();
    };
    window.addEventListener("keydown", keydown);
    return () => {
      clearTimeout(hideTimer.current);
      window.removeEventListener("keydown", keydown);
    };
  }, [shell]);
  return {
    visible: visible || effectivePinned || locked || menu,
    pinned,
    setPinned,
    menu,
    setMenu,
    reveal,
    tap: () => tap.current(),
    leave: () => hideLater(leaveDelay),
    conceal: () => {
      setMenu(false);
      setVisible(false);
    },
  };
}
