import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { forwardRef, isValidElement } from "react";
import { Button, type ButtonProps } from "./Button.js";
import { Icon } from "./Icon.js";
import { Tooltip } from "../overlays/Tooltip.js";

export type IconButtonIcon = LucideIcon | ReactNode;

export interface IconButtonProps extends Omit<ButtonProps, "aria-label" | "children" | "leadingIcon" | "trailingIcon"> {
  readonly icon: IconButtonIcon;
  readonly label: string;
  readonly pressed?: boolean;
  readonly tooltip?: string;
}

const REACT_FORWARD_REF_TYPE = Symbol.for("react.forward_ref");

interface ForwardRefIconCandidate {
  readonly $$typeof?: unknown;
  readonly displayName?: unknown;
  readonly render?: unknown;
}

function isLucideIconComponent(icon: IconButtonIcon): icon is LucideIcon {
  if (icon === null || typeof icon !== "object" || isValidElement(icon)) {
    return false;
  }

  const candidate = icon as ForwardRefIconCandidate;
  return candidate.$$typeof === REACT_FORWARD_REF_TYPE
    && typeof candidate.render === "function"
    && typeof candidate.displayName === "string"
    && candidate.displayName.length > 0;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, pressed, size = "sm", tooltip = label, variant = "ghost", ...props },
  ref,
) {
  const usesTypedLucideIcon = isLucideIconComponent(icon);
  const normalizedIcon = usesTypedLucideIcon ? (
    <span className="ling-ui-icon-button-normalized" data-ling-icon-button-normalized="">
      <Icon icon={icon} />
    </span>
  ) : icon;
  const button = (
    <Button
      {...props}
      ref={ref}
      aria-label={label}
      aria-pressed={pressed}
      data-icon-only="true"
      data-ling-icon-button-contract={usesTypedLucideIcon ? "typed-lucide" : "legacy-react-node"}
      leadingIcon={normalizedIcon}
      size={size}
      title={label}
      variant={variant}
    >
      <span className="ling-ui-sr-only">{label}</span>
    </Button>
  );

  return tooltip ? <Tooltip content={tooltip}>{button}</Tooltip> : button;
});
