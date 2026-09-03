import type { HTMLAttributes } from "react";
import { createContext, forwardRef, useContext } from "react";
import { Button, type ButtonProps, type ControlSize } from "./Button.js";
import { IconButton, type IconButtonProps } from "./IconButton.js";
import { mergeClassNames } from "../shared/merge-class-names.js";

const SplitButtonSizeContext = createContext<ControlSize>("md");

export interface SplitButtonProps extends HTMLAttributes<HTMLDivElement> {
  readonly size?: ControlSize;
}

export const SplitButton = forwardRef<HTMLDivElement, SplitButtonProps>(function SplitButton(
  { children, className, size = "md", ...props },
  ref,
) {
  return (
    <SplitButtonSizeContext value={size}>
      <div
        {...props}
        ref={ref}
        className={mergeClassNames("ling-ui-split-button", className)}
        data-ling-split-button="true"
        data-size={size}
      >
        {children}
      </div>
    </SplitButtonSizeContext>
  );
});

export const SplitButtonPrimary = forwardRef<HTMLButtonElement, ButtonProps>(function SplitButtonPrimary(
  { className, size, ...props },
  ref,
) {
  const inheritedSize = useContext(SplitButtonSizeContext);
  return (
    <Button
      {...props}
      ref={ref}
      className={mergeClassNames("ling-ui-split-button-primary", className)}
      size={size ?? inheritedSize}
    />
  );
});

export const SplitButtonTrigger = forwardRef<HTMLButtonElement, IconButtonProps>(function SplitButtonTrigger(
  { className, size, tooltip = "", ...props },
  ref,
) {
  const inheritedSize = useContext(SplitButtonSizeContext);
  return (
    <IconButton
      {...props}
      ref={ref}
      className={mergeClassNames("ling-ui-split-button-trigger", className)}
      size={size ?? inheritedSize}
      tooltip={tooltip}
    />
  );
});
