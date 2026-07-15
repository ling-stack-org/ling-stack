import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Code2,
  Download,
  FileText,
  FolderOpen,
  Loader2,
  SquareTerminal,
} from "lucide-react";
import {
  getWorkspaceFileOpenOptions,
  openWorkspaceFile,
  workspaceFileContentUrl,
  workspaceFileOpenIconUrl,
} from "../../../api.js";
import { useI18n } from "../../../i18n.js";
import type {
  WorkspaceFileOpenOption,
  WorkspaceFileOpenTarget,
} from "../../../types.js";

export function WorkspaceFileOpenMenu({
  cwd,
  path,
  line,
  compact = false,
  placement = "below",
}: {
  readonly cwd: string;
  readonly path: string;
  readonly line?: number;
  readonly compact?: boolean;
  readonly placement?: "below" | "auto";
}): JSX.Element {
  const { t } = useI18n();
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const popoverRef = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [options, setOptions] = useState<readonly WorkspaceFileOpenOption[]>([]);
  const [error, setError] = useState("");
  const [openPlacement, setOpenPlacement] = useState<WorkspaceFileOpenPlacement>({
    direction: "below",
    maxHeight: 320,
  });

  const updatePlacement = useCallback((): void => {
    if (placement !== "auto" || !rootRef.current) {
      return;
    }
    const desiredHeight = Math.min(popoverRef.current?.scrollHeight ?? 240, 320);
    const nextPlacement = resolveOpenPlacement(rootRef.current, desiredHeight);
    setOpenPlacement((current) => current.direction === nextPlacement.direction && current.maxHeight === nextPlacement.maxHeight
      ? current
      : nextPlacement);
  }, [placement]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const close = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    globalThis.addEventListener("pointerdown", close);
    return () => globalThis.removeEventListener("pointerdown", close);
  }, [open]);

  useLayoutEffect(() => {
    if (open) {
      updatePlacement();
    }
  }, [error, loading, open, options, updatePlacement]);

  useEffect(() => {
    if (!open || placement !== "auto") {
      return;
    }
    const refresh = (): void => updatePlacement();
    globalThis.addEventListener("resize", refresh);
    globalThis.addEventListener("scroll", refresh, true);
    return () => {
      globalThis.removeEventListener("resize", refresh);
      globalThis.removeEventListener("scroll", refresh, true);
    };
  }, [open, placement, updatePlacement]);

  async function toggle(): Promise<void> {
    const next = !open;
    if (next && placement === "auto" && rootRef.current) {
      setOpenPlacement(resolveOpenPlacement(rootRef.current, 240));
    }
    setOpen(next);
    setError("");
    if (!next || options.length > 0) {
      return;
    }
    setLoading(true);
    try {
      setOptions((await getWorkspaceFileOpenOptions(cwd, path)).options.filter((option) => option.available));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }

  async function launch(target: WorkspaceFileOpenTarget): Promise<void> {
    setError("");
    try {
      await openWorkspaceFile(cwd, path, { target, line });
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <span className={`workspace-file-open-menu ${openPlacement.direction}`} ref={rootRef}>
      <button
        className="workspace-file-open-trigger labeled"
        type="button"
        aria-label={t("Open with")}
        title={t("Open with")}
        aria-expanded={open}
        onClick={() => void toggle()}
      >
        <span>{t(compact ? "Open" : "Open with")}</span>
        <ChevronDown size={13} />
      </button>
      {open ? (
        <span
          className="workspace-file-open-popover"
          ref={popoverRef}
          style={placement === "auto" ? { maxHeight: openPlacement.maxHeight } : undefined}
        >
          <strong>{t("Open with")}</strong>
          {loading ? <span className="workspace-file-open-loading"><Loader2 className="spin" size={13} />{t("Loading")}</span> : null}
          {options.map((option) => (
            <button type="button" key={option.id} onClick={() => void launch(option.id)}>
              <OpenTargetIcon cwd={cwd} target={option.id} />
              <span>{openTargetLabel(option, t)}</span>
            </button>
          ))}
          <a href={workspaceFileContentUrl(cwd, path, true)} download>
            <Download size={13} />
            <span>{t("Download")}</span>
          </a>
          {error ? <small title={error}>{error}</small> : null}
        </span>
      ) : null}
    </span>
  );
}

interface WorkspaceFileOpenPlacement {
  readonly direction: "above" | "below";
  readonly maxHeight: number;
}

function resolveOpenPlacement(element: HTMLElement, desiredHeight: number): WorkspaceFileOpenPlacement {
  const elementRect = element.getBoundingClientRect();
  const boundary = nearestVerticalClipBoundary(element);
  const spaceAbove = Math.max(0, elementRect.top - boundary.top - 4);
  const spaceBelow = Math.max(0, boundary.bottom - elementRect.bottom - 4);
  const direction = spaceAbove >= desiredHeight || spaceAbove >= spaceBelow ? "above" : "below";
  const availableHeight = direction === "above" ? spaceAbove : spaceBelow;
  return {
    direction,
    maxHeight: Math.floor(Math.min(320, availableHeight)),
  };
}

function nearestVerticalClipBoundary(element: HTMLElement): { readonly top: number; readonly bottom: number } {
  let parent = element.parentElement;
  while (parent) {
    const overflowY = getComputedStyle(parent).overflowY;
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "hidden" || overflowY === "clip") {
      const rect = parent.getBoundingClientRect();
      return {
        top: Math.max(0, rect.top),
        bottom: Math.min(globalThis.innerHeight, rect.bottom),
      };
    }
    parent = parent.parentElement;
  }
  return { top: 0, bottom: globalThis.innerHeight };
}

function openTargetLabel(option: WorkspaceFileOpenOption, t: (key: string) => string): string {
  if (option.id === "finder") return t("Show in Finder");
  if (option.id === "terminal") return t("Terminal");
  return option.label;
}

function OpenTargetIcon({
  cwd,
  target,
}: {
  readonly cwd: string;
  readonly target: WorkspaceFileOpenTarget;
}): JSX.Element {
  const [failed, setFailed] = useState(false);
  const fallback = openTargetFallbackIcon(target);
  if (target === "finder" || target === "terminal" || failed) {
    return <span className="workspace-file-open-target-icon" aria-hidden="true">{fallback}</span>;
  }
  return (
    <span className="workspace-file-open-target-icon" aria-hidden="true">
      <img
        alt=""
        src={workspaceFileOpenIconUrl(cwd, target)}
        onError={() => setFailed(true)}
      />
    </span>
  );
}

function openTargetFallbackIcon(target: WorkspaceFileOpenTarget): JSX.Element {
  if (target === "finder") return <FolderOpen />;
  if (target === "terminal") return <SquareTerminal />;
  if (target === "textedit") return <FileText />;
  return <Code2 />;
}
