import type { LocalFileReference } from "../tokens/message-body.js";

export interface LocalFileLinkProps {
  readonly reference: LocalFileReference;
  readonly onOpen?: (reference: LocalFileReference) => void;
}

export function LocalFileLink({ reference, onOpen }: LocalFileLinkProps): React.JSX.Element {
  const className = reference.insideWorkspace
    ? "message-local-file-link"
    : "message-local-file-link outside-workspace";
  const title = reference.insideWorkspace
    ? reference.raw
    : `${reference.raw} (outside workspace)`;

  if (reference.insideWorkspace && onOpen) {
    return (
      <button
        className={className}
        type="button"
        title={title}
        onClick={() => onOpen(reference)}
      >
        <span className="message-inline-token-icon" aria-hidden="true">F</span>
        <strong>{localFilePrimaryLabel(reference)}</strong>
        {localFileSecondaryLabel(reference) ? <small>{localFileSecondaryLabel(reference)}</small> : null}
      </button>
    );
  }

  return (
    <span className={className} title={title}>
      <span className="message-inline-token-icon" aria-hidden="true">F</span>
      <strong>{localFilePrimaryLabel(reference)}</strong>
      {localFileSecondaryLabel(reference) ? <small>{localFileSecondaryLabel(reference)}</small> : null}
    </span>
  );
}

function localFilePrimaryLabel(reference: LocalFileReference): string {
  const withoutLocation = reference.displayPath.replace(reference.location ?? "", "");
  const parts = withoutLocation.split("/").filter(Boolean);
  return parts.at(-1) ?? (withoutLocation || reference.displayPath);
}

function localFileSecondaryLabel(reference: LocalFileReference): string | undefined {
  const location = reference.location;
  const withoutLocation = reference.displayPath.replace(location ?? "", "");
  const parts = withoutLocation.split("/").filter(Boolean);
  const folder = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
  if (location && folder) {
    return `${folder}${location}`;
  }
  return location ?? (folder || undefined);
}
