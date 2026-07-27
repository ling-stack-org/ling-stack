import { forwardRef, type HTMLAttributes } from "react";
import { mergeClassNames } from "../shared/merge-class-names.js";

export type SkeletonShape = "text" | "block" | "circle";

export interface SkeletonProps extends HTMLAttributes<HTMLSpanElement> {
  readonly height?: number | string;
  readonly shape?: SkeletonShape;
  readonly width?: number | string;
}

function cssSize(value: number | string | undefined): string | undefined {
  return typeof value === "number" ? `${value}px` : value;
}

export const Skeleton = forwardRef<HTMLSpanElement, SkeletonProps>(function Skeleton(
  { className, height, shape = "text", style, width, ...props },
  ref,
) {
  return (
    <span
      {...props}
      ref={ref}
      aria-hidden="true"
      className={mergeClassNames("ling-ui-skeleton", className)}
      data-shape={shape}
      style={{ ...style, width: cssSize(width) ?? style?.width, height: cssSize(height) ?? style?.height }}
    />
  );
});
