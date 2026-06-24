import type { ReactNode } from "react";
import { EvidenceDisclosure } from "./EvidenceDisclosure.js";

export interface ConversationEvidenceItem {
  readonly id: string;
  readonly label: string;
  readonly value?: ReactNode;
  readonly meta?: ReactNode;
  readonly status?: ReactNode;
  readonly icon?: ReactNode;
}

export interface ConversationEvidenceSection {
  readonly id: string;
  readonly label: string;
  readonly summary?: string;
  readonly icon?: ReactNode;
  readonly items?: readonly ConversationEvidenceItem[];
  readonly content?: ReactNode;
}

export interface ConversationEvidenceBundle {
  readonly summary?: string;
  readonly sections: readonly ConversationEvidenceSection[];
}

export interface ConversationEvidenceBundlePanelProps {
  readonly className?: string;
  readonly label: string;
  readonly bundle: ConversationEvidenceBundle;
  readonly defaultOpen?: boolean;
}

export function ConversationEvidenceBundlePanel({
  className,
  label,
  bundle,
  defaultOpen,
}: ConversationEvidenceBundlePanelProps): JSX.Element | null {
  const sections = bundle.sections.filter((section) => section.content || (section.items && section.items.length > 0));
  if (sections.length === 0) {
    return null;
  }

  const summary = bundle.summary ?? sections.map((section) => section.summary ?? section.label).join(" · ");

  return (
    <EvidenceDisclosure className={className} label={label} summary={summary} defaultOpen={defaultOpen}>
      <div className="conversation-evidence-bundle">
        {sections.map((section) => (
          <section key={section.id} className="conversation-evidence-section" aria-label={section.label}>
            <header>
              <span>
                {section.icon}
                <strong>{section.label}</strong>
              </span>
              {section.summary ? <small>{section.summary}</small> : null}
            </header>
            {section.items && section.items.length > 0 ? (
              <ul>
                {section.items.map((item) => (
                  <li key={item.id}>
                    <span>
                      {item.icon}
                      <strong>{item.label}</strong>
                    </span>
                    {item.value ? <em>{item.value}</em> : null}
                    {item.meta ? <small>{item.meta}</small> : null}
                    {item.status ? <small>{item.status}</small> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {section.content ? <div className="conversation-evidence-section-content">{section.content}</div> : null}
          </section>
        ))}
      </div>
    </EvidenceDisclosure>
  );
}
