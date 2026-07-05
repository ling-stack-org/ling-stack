import type { ReactNode } from "react";
import { X } from "lucide-react";

export function CreateDialogShell({
  ariaLabel,
  title,
  description,
  children,
  footer,
  onClose,
  closeLabel,
  className = "",
  overlayClassName = "",
  bodyClassName = "",
}: {
  readonly ariaLabel: string;
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
  readonly footer: ReactNode;
  readonly onClose: () => void;
  readonly closeLabel: string;
  readonly className?: string;
  readonly overlayClassName?: string;
  readonly bodyClassName?: string;
}): JSX.Element {
  const overlayClasses = ["create-dialog-overlay", overlayClassName].filter(Boolean).join(" ");
  const shellClasses = ["create-dialog-shell", className].filter(Boolean).join(" ");
  const bodyClasses = ["create-dialog-body", bodyClassName].filter(Boolean).join(" ");

  return (
    <div
      className={overlayClasses}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section className={shellClasses} role="dialog" aria-modal="true" aria-label={ariaLabel}>
        <div className="create-dialog-head">
          <div className="create-dialog-title-block">
            <strong>{title}</strong>
            <p>{description}</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label={closeLabel} title={closeLabel}>
            <X size={14} />
          </button>
        </div>
        <div className={bodyClasses}>
          {children}
          <div className="create-dialog-actions">
            {footer}
          </div>
        </div>
      </section>
    </div>
  );
}
