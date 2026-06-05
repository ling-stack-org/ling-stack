import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

export interface EvidenceDisclosureProps {
  readonly className?: string;
  readonly label: string;
  readonly summary: string;
  readonly defaultOpen?: boolean;
  readonly children: ReactNode;
}

export function EvidenceDisclosure({
  className,
  label,
  summary,
  defaultOpen = false,
  children,
}: EvidenceDisclosureProps): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const rootClassName = ["conversation-evidence", className].filter(Boolean).join(" ");

  return (
    <section className={rootClassName} aria-label={label}>
      <button
        className="conversation-evidence-toggle"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span>{summary}</span>
      </button>
      {open ? <div className="conversation-evidence-body">{children}</div> : null}
    </section>
  );
}
