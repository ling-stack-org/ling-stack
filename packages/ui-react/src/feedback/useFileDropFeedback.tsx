import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";

type DropEdge = "top" | "right" | "bottom" | "left";

interface DropGlint {
  readonly id: number;
  readonly edge: DropEdge;
  readonly offset: number;
}

/** Reception feedback only. Validation and upload results belong to the caller. */
export function useFileDropFeedback(input: {
  readonly blocked: boolean;
  readonly resetKey: string;
  readonly onFiles: (files: FileList) => void | Promise<void>;
}): {
  readonly active: boolean;
  readonly feedback: ReactNode;
  readonly onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  readonly onDragLeave: (event: DragEvent<HTMLDivElement>) => void;
  readonly onDrop: (event: DragEvent<HTMLDivElement>) => void;
} {
  const [active, setActive] = useState(false);
  const [glint, setGlint] = useState<DropGlint>();
  const sequence = useRef(0);

  useEffect(() => {
    setActive(false);
    setGlint(undefined);
  }, [input.blocked, input.resetKey]);

  useEffect(() => {
    const clearDrag = (): void => setActive(false);
    const clearAll = (): void => { clearDrag(); setGlint(undefined); };
    const leaveWindow = (event: globalThis.DragEvent): void => {
      if (event.relatedTarget === null && event.target === document.documentElement) clearDrag();
    };
    const hide = (): void => { if (document.hidden) clearAll(); };
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const forcedColors = window.matchMedia("(forced-colors: active)");
    window.addEventListener("dragend", clearDrag);
    window.addEventListener("drop", clearDrag);
    window.addEventListener("blur", clearAll);
    document.addEventListener("dragleave", leaveWindow);
    document.addEventListener("visibilitychange", hide);
    reducedMotion.addEventListener("change", clearAll);
    forcedColors.addEventListener("change", clearAll);
    return () => {
      window.removeEventListener("dragend", clearDrag);
      window.removeEventListener("drop", clearDrag);
      window.removeEventListener("blur", clearAll);
      document.removeEventListener("dragleave", leaveWindow);
      document.removeEventListener("visibilitychange", hide);
      reducedMotion.removeEventListener("change", clearAll);
      forcedColors.removeEventListener("change", clearAll);
    };
  }, []);

  return {
    active: active && !input.blocked,
    feedback: (
      <span aria-hidden="true" className="ling-ui-file-drop-feedback" data-active={active && !input.blocked || undefined}>
        {glint && !input.blocked ? (
          <span
            key={glint.id}
            className="ling-ui-file-drop-glint"
            data-edge={glint.edge}
            style={{ "--ling-drop-offset": `${glint.offset}px` } as CSSProperties}
            onAnimationEnd={() => setGlint((current) => current?.id === glint.id ? undefined : current)}
          />
        ) : null}
      </span>
    ),
    onDragOver(event) {
      if (!hasFiles(event)) return;
      // Also suppress native file navigation when this target is unavailable.
      event.preventDefault();
      event.dataTransfer.dropEffect = input.blocked ? "none" : "copy";
      setActive(!input.blocked);
    },
    onDragLeave(event) {
      const next = event.relatedTarget;
      if (next instanceof Node && event.currentTarget.contains(next)) return;
      // External OS drags often omit relatedTarget, even between children.
      const bounds = event.currentTarget.getBoundingClientRect();
      if (next === null && event.clientX > bounds.left && event.clientX < bounds.right
        && event.clientY > bounds.top && event.clientY < bounds.bottom) return;
      setActive(false);
    },
    onDrop(event) {
      event.preventDefault();
      setActive(false);
      if (input.blocked || !hasFiles(event) || event.dataTransfer.files.length === 0) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (!window.matchMedia("(prefers-reduced-motion: reduce), (forced-colors: active)").matches) {
        const x = Math.max(0, Math.min(bounds.width, event.clientX - bounds.left));
        const y = Math.max(0, Math.min(bounds.height, event.clientY - bounds.top));
        const edge = nearestEdge(x, y, bounds.width, bounds.height);
        const length = edge === "top" || edge === "bottom" ? bounds.width : bounds.height;
        const position = edge === "top" || edge === "bottom" ? x : y;
        const inset = Math.min(28, length / 2);
        setGlint({ id: ++sequence.current, edge, offset: Math.max(inset, Math.min(length - inset, position)) });
      }
      void input.onFiles(event.dataTransfer.files);
    },
  };
}

function nearestEdge(x: number, y: number, width: number, height: number): DropEdge {
  const distances: readonly [DropEdge, number][] = [
    ["top", y], ["right", width - x], ["bottom", height - y], ["left", x],
  ];
  return distances.reduce((nearest, candidate) => candidate[1] < nearest[1] ? candidate : nearest)[0];
}

function hasFiles(event: DragEvent<HTMLDivElement>): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}
