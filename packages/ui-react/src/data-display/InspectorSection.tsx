import { ChevronRight } from "lucide-react";
import { forwardRef, type DetailsHTMLAttributes, type ReactNode } from "react";
import { mergeClassNames } from "../shared/merge-class-names.js";

export type InspectorSectionAppearance = "divided" | "plain";

export interface InspectorSectionProps extends Omit<DetailsHTMLAttributes<HTMLDetailsElement>, "title"> {
  readonly action?: ReactNode;
  readonly appearance?: InspectorSectionAppearance;
  readonly summary?: ReactNode;
  readonly title: ReactNode;
}

export const InspectorSection = forwardRef<HTMLDetailsElement, InspectorSectionProps>(function InspectorSection(
  { action, appearance = "divided", children, className, summary, title, ...props },
  ref,
) {
  return (
    <details
      {...props}
      ref={ref}
      className={mergeClassNames("ling-ui-inspector-section", className)}
      data-appearance={appearance}
    >
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
