import type { LocalFileReference } from "../tokens/message-body.js";
import { useContext, useState } from "react";
import { File } from "lucide-react";
import { useI18n } from "../../../i18n.js";
import { LocalFilePreviewContext } from "./local-file-preview-context.js";

export interface LocalFileLinkProps {
  readonly reference: LocalFileReference;
  readonly onOpen?: (reference: LocalFileReference) => void;
}

export function LocalFileLink({ reference, onOpen }: LocalFileLinkProps): React.JSX.Element {
  const context = useContext(LocalFilePreviewContext);
  const cwd = context?.cwd;
  const onOpenNativeFile = context?.openPreview;
  const { t, locale } = useI18n();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const localFiles = globalThis.window?.lingDesktop?.localFiles;
  const native = Boolean(localFiles && onOpenNativeFile);
  const request = {
    path: reference.location ? reference.raw.slice(0, -reference.location.length) : reference.raw,
    cwd,
    line: reference.location ? Number(reference.location.match(/\d+/u)?.[0]) || undefined : undefined,
    locale,
  };
  const openNative = async (menu: boolean): Promise<void> => {
    if (!localFiles || !onOpenNativeFile) return;
    setError("");
    setBusy(true);
    const publish = context?.beginRequest();
    try {
      const preview = await (menu ? localFiles.showMenu(request) : localFiles.inspect(request));
      if (preview) publish?.(preview);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const className = reference.insideWorkspace
    ? "message-local-file-link"
    : "message-local-file-link outside-workspace";
  const title = native || reference.insideWorkspace
    ? reference.raw
    : `${reference.raw} (outside workspace)`;

  if (native || (reference.insideWorkspace && onOpen)) {
    return (
      <span className="message-local-file-control">
        <button
        className={className}
        type="button"
        title={title}
        data-local-file-path={native ? request.path : undefined}
        data-local-file-cwd={native ? cwd ?? "" : undefined}
        aria-busy={busy}
        onClick={() => native ? void openNative(false) : onOpen?.(reference)}
        onContextMenu={native ? (event) => { event.preventDefault(); void openNative(true); } : undefined}
      >
        <File size={14} aria-hidden="true" />
        <strong>{localFilePrimaryLabel(reference)}</strong>
        {localFileSecondaryLabel(reference) ? <small>{localFileSecondaryLabel(reference)}</small> : null}
        </button>
        {error ? <small className="message-local-file-error" role="alert" title={error}>{t("Unable to preview this file")}</small> : null}
      </span>
    );
  }

  return (
    <span className={className} title={title}>
      <File size={14} aria-hidden="true" />
      <strong>{localFilePrimaryLabel(reference)}</strong>
      {localFileSecondaryLabel(reference) ? <small>{localFileSecondaryLabel(reference)}</small> : null}
    </span>
  );
}

function localFilePrimaryLabel(reference: LocalFileReference): string {
  if (reference.label) return reference.label;
  const withoutLocation = reference.displayPath.replace(reference.location ?? "", "");
  const parts = withoutLocation.split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) ?? (withoutLocation || reference.displayPath);
}

function localFileSecondaryLabel(reference: LocalFileReference): string | undefined {
  const location = reference.location;
  const withoutLocation = reference.displayPath.replace(location ?? "", "");
  const parts = withoutLocation.split(/[\\/]/u).filter(Boolean);
  const folder = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
  if (location && folder) {
    return `${folder}${location}`;
  }
  return location ?? (folder || undefined);
}
