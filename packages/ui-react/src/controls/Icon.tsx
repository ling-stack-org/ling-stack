import type { LucideIcon } from "lucide-react";

export type IconSize = "xs" | "sm" | "md" | "lg" | "xl";
export type IconTone = "default" | "muted" | "success" | "warning" | "danger" | "info";

interface IconBaseProps {
  readonly icon: LucideIcon;
  readonly size?: IconSize;
  readonly tone?: IconTone;
}

export type IconProps = IconBaseProps & (
  | {
      readonly decorative?: true;
      readonly label?: undefined;
    }
  | {
      readonly decorative?: false;
      readonly label: string;
    }
);

export function Icon({ decorative, icon: IconComponent, label, size = "sm", tone = "default" }: IconProps) {
  if (decorative === true && label !== undefined) {
    throw new TypeError("Icon cannot combine label with decorative=true.");
  }
  if (decorative === false && (!label || label.trim().length === 0)) {
    throw new TypeError("Icon requires a non-empty label when decorative=false.");
  }
  if (label !== undefined && label.trim().length === 0) {
    throw new TypeError("Icon requires a non-empty label when it is not decorative.");
  }

  const isDecorative = label === undefined;

  return (
    <IconComponent
      className="ling-ui-icon"
      data-ling-icon=""
      data-size={size}
      data-tone={tone}
      aria-hidden={isDecorative ? true : undefined}
      aria-label={isDecorative ? undefined : label}
      focusable="false"
      role={isDecorative ? undefined : "img"}
    />
  );
}
