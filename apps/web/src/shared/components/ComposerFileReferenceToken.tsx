import { FileText, X } from "lucide-react";

export interface ComposerFileReferenceTokenProps {
  readonly path: string;
  readonly line?: number;
  readonly removeLabel?: string;
  readonly onRemove?: () => void;
}

export function ComposerFileReferenceToken({ path, line, removeLabel, onRemove }: ComposerFileReferenceTokenProps): React.JSX.Element {
  return (
    <span className="composer-structured-token file-reference">
      <FileText size={13} />
      <strong title={path}>{path}</strong>
      {line !== undefined ? <small>:{line}</small> : null}
      {onRemove ? (
        <button type="button" onClick={onRemove} aria-label={removeLabel ?? `Remove ${path}`}>
          <X size={12} />
        </button>
      ) : null}
    </span>
  );
}
