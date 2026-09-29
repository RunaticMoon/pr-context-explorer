import { useEffect } from "react";
import { useReactFlow, useStore } from "@xyflow/react";
export const GRAPH_FIT = { padding: 0.15, minZoom: 0.6, maxZoom: 1.1 } as const;
/** Re-fits the viewport whenever the visible node set or the canvas size changes. */
export function GraphAutoFit({ signature }: { signature: string }) {
  const { fitView } = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  useEffect(() => {
    // The xyflow store starts at width/height 0 and only later reflects real
    // measurements, so skip fitting until the canvas has a usable size.
    if (width <= 1 || height <= 1) return;
    const id = requestAnimationFrame(() => {
      void fitView({ ...GRAPH_FIT, duration: 150 });
    });
    return () => cancelAnimationFrame(id);
  }, [signature, width, height, fitView]);
  return null;
}
