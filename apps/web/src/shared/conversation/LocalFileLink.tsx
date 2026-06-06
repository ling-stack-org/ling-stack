import type { LocalFileReference } from "./message-body.js";

export interface LocalFileLinkProps {
  readonly reference: LocalFileReference;
  readonly onOpen?: (reference: LocalFileReference) => void;
}

export function LocalFileLink({ reference, onOpen }: LocalFileLinkProps): JSX.Element {
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
        {reference.displayPath}
      </button>
    );
  }

  return (
    <span className={className} title={title}>
      {reference.displayPath}
    </span>
  );
}
