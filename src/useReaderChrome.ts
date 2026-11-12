import { useEffect, useRef, useState, type RefObject } from "react";
import { bindReadingTaps } from "./reader/gestures";
const key = "leafmark-controls-pinned";
export function useReaderChrome(
  shell: RefObject<HTMLElement | null>,
  host: RefObject<HTMLDivElement | null>,
  ready: number,
  locked: boolean,
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
  const current = useRef({ locked, pinned, menu });
  current.current = { locked, pinned, menu };
  const protectedNow = () =>
    current.current.locked ||
    current.current.pinned ||
    current.current.menu ||
    !!shell.current?.querySelector(".passage-popup") ||
    !!shell.current?.querySelector(
      ".reader-header :focus-visible,.reader-footer :focus-visible",
    );
  const reveal = () => {
    clearTimeout(hideTimer.current);
    setVisible(true);
  };
  const hide = () => {
    if (!protectedNow()) setVisible(false);
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
    if (!host.current) return;
    return bindReadingTaps(host.current, () => tap.current());
  }, [ready, host]);
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
    visible: visible || pinned || locked || menu,
    pinned,
    setPinned,
    menu,
    setMenu,
    reveal,
    hide,
    tap: () => tap.current(),
    leave: () => {
      clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(hide, 300);
    },
    conceal: () => {
      setMenu(false);
      setVisible(false);
    },
  };
}
