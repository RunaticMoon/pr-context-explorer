import { useEffect, useRef } from "react";
import {
  useReactFlow,
  useStore,
  useOnViewportChange,
  type Viewport,
} from "@xyflow/react";
export const GRAPH_FIT = { padding: 0.15, minZoom: 0.6, maxZoom: 1.1 } as const;
const viewports = new Map<string, Viewport>();
/** Fit on first open only. Commit/file changes must not undo manual pan/zoom. */
export function GraphAutoFit({
  signature,
  storageKey,
}: {
  signature: string;
  storageKey?: string;
}) {
  const { fitView, setViewport } = useReactFlow();
  const initialized = useRef(false);
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  useOnViewportChange({
    onEnd: (viewport) => {
      if (!storageKey || !initialized.current) return;
      viewports.set(storageKey, viewport);
      if (viewports.size > 32) viewports.delete(viewports.keys().next().value!);
    },
  });
  useEffect(() => {
    if (initialized.current || width <= 1 || height <= 1) return;
    const id = requestAnimationFrame(() => {
      initialized.current = true;
      const saved = storageKey && viewports.get(storageKey);
      if (saved) void setViewport(saved, { duration: 0 });
      else void fitView({ ...GRAPH_FIT, duration: 0 });
    });
    return () => cancelAnimationFrame(id);
  }, [signature, storageKey, width, height, fitView, setViewport]);
  return null;
}
