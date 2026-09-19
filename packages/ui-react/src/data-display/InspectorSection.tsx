import { ChevronRight } from "lucide-react";
import { forwardRef, type DetailsHTMLAttributes, type ReactNode } from "react";
import { mergeClassNames } from "../shared/merge-class-names.js";

export interface InspectorSectionProps extends Omit<DetailsHTMLAttributes<HTMLDetailsElement>, "title"> {
  readonly action?: ReactNode;
  readonly summary?: ReactNode;
  readonly title: ReactNode;
}

export const InspectorSection = forwardRef<HTMLDetailsElement, InspectorSectionProps>(function InspectorSection(
  { action, children, className, summary, title, ...props },
  ref,
) {
  return (
    <details {...props} ref={ref} className={mergeClassNames("ling-ui-inspector-section", className)}>
      <summary className="ling-ui-inspector-section-trigger">
        <ChevronRight className="ling-ui-inspector-section-chevron" aria-hidden="true" />
        <span className="ling-ui-inspector-section-heading">
          <strong>{title}</strong>
          {summary ? <span>{summary}</span> : null}
        </span>
        {action ? <span className="ling-ui-inspector-section-action">{action}</span> : null}
      </summary>
      <div className="ling-ui-inspector-section-body">{children}</div>
    </details>
  );
});
