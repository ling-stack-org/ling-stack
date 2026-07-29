import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { mergeClassNames } from "../shared/merge-class-names.js";

export type InlineFeedbackTone = "neutral" | "info" | "success" | "warning" | "danger";

export interface InlineFeedbackProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  readonly title?: ReactNode;
  readonly tone?: InlineFeedbackTone;
}

export const InlineFeedback = forwardRef<HTMLDivElement, InlineFeedbackProps>(function InlineFeedback(
  { children, className, role, title, tone = "neutral", ...props },
  ref,
) {
  return (
    <div
      {...props}
      ref={ref}
      className={mergeClassNames("ling-ui-inline-feedback", className)}
      data-tone={tone}
      role={role ?? (tone === "danger" ? "alert" : "status")}
    >
      {title ? <strong className="ling-ui-inline-feedback-title">{title}</strong> : null}
      {children ? (
        <div
          className="ling-ui-inline-feedback-detail"
          data-ling-inline-feedback-slot="detail"
        >
          {children}
        </div>
      ) : null}
    </div>
  );
});
