import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "../../ui/index.js";

export interface EvidenceDisclosureProps {
  readonly className?: string;
  readonly label: string;
  readonly summary: ReactNode;
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
      <Button
        className="conversation-evidence-toggle"
        aria-expanded={open}
        leadingIcon={open ? <ChevronDown /> : <ChevronRight />}
        size="sm"
        variant="ghost"
        onClick={() => setOpen((current) => !current)}
      >
        {summary}
      </Button>
      {open ? <div className="conversation-evidence-body">{children}</div> : null}
    </section>
  );
}
