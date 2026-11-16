import { useEffect, useState, type RefObject } from "react";

export function useReaderFullscreen(shell: RefObject<HTMLElement | null>, notify: (message: string) => void) {
  const [active, setActive] = useState(false);
  useEffect(() => {
    const changed = () => setActive(!!shell.current && document.fullscreenElement === shell.current);
    document.addEventListener("fullscreenchange", changed);
    return () => {
      document.removeEventListener("fullscreenchange", changed);
      if (shell.current && document.fullscreenElement === shell.current) void document.exitFullscreen().catch(() => {});
    };
  }, [shell]);
  return {
    active,
    // Call synchronously from the click handler, before saving or other awaits:
    // Android browsers require the original transient user activation.
    enter: () => {
      const element = shell.current;
      if (!element?.requestFullscreen) {
        notify("Quiet reading is on. This browser cannot hide the device bars.");
        return Promise.resolve(false);
      }
      try {
        return element.requestFullscreen({ navigationUI: "hide" }).then(() => true).catch(() => {
          notify("Quiet reading is on. The browser did not allow fullscreen; device bars may remain visible.");
          return false;
        });
      } catch {
        notify("Quiet reading is on. Fullscreen is unavailable in this browser.");
        return Promise.resolve(false);
      }
    },
    exit: () => document.fullscreenElement ? document.exitFullscreen().catch(() => {}) : Promise.resolve(),
  };
}
