import {
  Children,
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";
import { mergeClassNames } from "../shared/merge-class-names.js";

interface FieldControlProps {
  readonly "aria-describedby"?: string;
  readonly "aria-invalid"?: boolean | "false" | "true";
  readonly id?: string;
  readonly required?: boolean;
}

export interface FieldProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  readonly children: ReactElement<FieldControlProps>;
  readonly controlId?: string;
  readonly description?: ReactNode;
  readonly error?: ReactNode;
  readonly label: ReactNode;
  readonly required?: boolean;
}

export const Field = forwardRef<HTMLDivElement, FieldProps>(function Field(
  {
    children,
    className,
    controlId,
    description,
    error,
    label,
    required = false,
    ...props
  },
  ref,
) {
  const generatedId = useId();
  const child = Children.only(children);
  if (!isValidElement<FieldControlProps>(child)) {
    throw new Error("Field requires exactly one form control child.");
  }
  const resolvedControlId = child.props.id ?? controlId ?? `${generatedId}-control`;
  const descriptionId = description ? `${resolvedControlId}-description` : undefined;
  const errorId = error ? `${resolvedControlId}-error` : undefined;
  const describedBy = [child.props["aria-describedby"], descriptionId, errorId].filter(Boolean).join(" ") || undefined;
  const control = cloneElement(child, {
    id: resolvedControlId,
    "aria-describedby": describedBy,
    "aria-invalid": error ? true : child.props["aria-invalid"],
    required: required || child.props.required,
  });

  return (
    <div
      {...props}
      ref={ref}
      className={mergeClassNames("ling-ui-field", className)}
      data-invalid={error ? "true" : undefined}
    >
      <label className="ling-ui-field-label" htmlFor={resolvedControlId}>
        <span>{label}</span>
        {required ? <span className="ling-ui-field-required" aria-hidden="true">*</span> : null}
      </label>
      {control}
      {description ? <div className="ling-ui-field-description" id={descriptionId}>{description}</div> : null}
      {error ? <div className="ling-ui-field-error" id={errorId}>{error}</div> : null}
    </div>
  );
});
