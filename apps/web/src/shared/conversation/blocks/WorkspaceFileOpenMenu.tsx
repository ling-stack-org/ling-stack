import { useEffect, useRef, useState } from "react";
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
}: {
  readonly cwd: string;
  readonly path: string;
  readonly line?: number;
  readonly compact?: boolean;
}): JSX.Element {
  const { t } = useI18n();
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [options, setOptions] = useState<readonly WorkspaceFileOpenOption[]>([]);
  const [error, setError] = useState("");

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

  async function toggle(): Promise<void> {
    const next = !open;
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
    <span className="workspace-file-open-menu" ref={rootRef}>
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
        <span className="workspace-file-open-popover">
          <strong>{t("Open with")}</strong>
          {loading ? <span className="workspace-file-open-loading"><Loader2 className="spin" size={13} />{t("Loading")}</span> : null}
          {options.map((option) => (
            <button type="button" key={option.id} onClick={() => void launch(option.id)}>
              {openTargetIcon(option.id)}
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

function openTargetLabel(option: WorkspaceFileOpenOption, t: (key: string) => string): string {
  if (option.id === "finder") return t("Show in Finder");
  if (option.id === "terminal") return t("Terminal");
  return option.label;
}

function openTargetIcon(target: WorkspaceFileOpenTarget): JSX.Element {
  if (target === "finder") return <FolderOpen size={13} />;
  if (target === "terminal") return <SquareTerminal size={13} />;
  if (target === "textedit") return <FileText size={13} />;
  return <Code2 size={13} />;
}
