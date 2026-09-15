import { useEffect, useRef, useState, type RefObject } from "react";
import {
  MAP_PIN_COARSE_PX,
  MAP_PIN_PX,
  type MapLayoutOptions,
} from "./projection";

/**
 * Measures the map box and the pointer kind. The pin placement needs both: a
 * degree is a different distance on a phone than on a desktop, and the coarse
 * pointer rule grows every button to 44px.
 */
export function useMapMetrics(): [RefObject<HTMLDivElement | null>, MapLayoutOptions] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [metrics, setMetrics] = useState<MapLayoutOptions>({
    widthPx: 0,
    pinPx: MAP_PIN_PX,
  });

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => {
      setMetrics({
        widthPx: node.getBoundingClientRect().width,
        pinPx: isCoarsePointer() ? MAP_PIN_COARSE_PX : MAP_PIN_PX,
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return [ref, metrics];
}

function isCoarsePointer(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches
  );
}
