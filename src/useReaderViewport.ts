import { useEffect, useState } from "react";

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export function useReaderViewport() {
  const narrow = useMediaQuery("(max-width: 759px)");
  const touch = useMediaQuery("(any-pointer: coarse)");
  return { narrow, touch };
}
