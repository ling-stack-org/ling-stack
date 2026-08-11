import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import { Check } from "lucide-react";
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ElementRef,
  type ReactNode,
} from "react";
import { Spinner } from "../feedback/Spinner.js";
import { mergeClassNames } from "../shared/merge-class-names.js";

export interface ThemePickerSwatch {
  readonly accent: string;
  readonly app: string;
  readonly danger: string;
  readonly info: string;
  readonly panel: string;
  readonly success: string;
  readonly text: string;
  readonly warning: string;
}

export interface ThemePickerOption {
  readonly accessibleLabel: string;
  readonly actions?: ReactNode;
  readonly colorSchemeLabel: string;
  readonly disabled?: boolean;
  readonly disabledReason?: ReactNode;
  readonly id: string;
  readonly name: string;
  readonly sourceLabel?: ReactNode;
  readonly swatch: ThemePickerSwatch;
}

export interface ThemePickerProps extends Omit<
  ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root>,
  "aria-label" | "children" | "defaultValue" | "onValueChange" | "type" | "value"
> {
  readonly "aria-label": string;
  readonly activeThemeId?: string;
  readonly applyingLabel: string;
  readonly applyingThemeId?: string;
  readonly onThemeSelect: (themeId: string) => void;
  readonly options: readonly ThemePickerOption[];
  readonly selectedThemeId?: string;
}

export const ThemePicker = forwardRef<
  ElementRef<typeof ToggleGroupPrimitive.Root>,
  ThemePickerProps
>(function ThemePicker(
  {
    "aria-label": ariaLabel,
    activeThemeId,
    applyingLabel,
    applyingThemeId,
    className,
    onThemeSelect,
    options,
    selectedThemeId,
    ...props
  },
  ref,
) {
  return (
    <ToggleGroupPrimitive.Root
      {...props}
      ref={ref}
      aria-label={ariaLabel}
      className={mergeClassNames("ling-ui-theme-picker", className)}
      type="single"
      value={selectedThemeId ?? ""}
      onValueChange={(themeId) => {
        if (themeId) onThemeSelect(themeId);
      }}
    >
      {options.map((option) => {
        const active = option.id === activeThemeId;
        const applying = option.id === applyingThemeId;
        const selected = option.id === selectedThemeId;
        return (
          <span
            key={option.id}
            className="ling-ui-theme-option-frame"
            data-has-actions={option.actions ? "true" : undefined}
          >
            <ToggleGroupPrimitive.Item
              aria-busy={applying || undefined}
              aria-label={option.accessibleLabel}
              className="ling-ui-theme-option"
              data-active={active || undefined}
              data-applying={applying || undefined}
              data-theme-option-id={option.id}
              disabled={option.disabled}
              title={typeof option.disabledReason === "string" ? option.disabledReason : undefined}
              value={option.id}
            >
              <ThemeOptionSwatch swatch={option.swatch} />
              <span className="ling-ui-theme-option-body">
                <span className="ling-ui-theme-option-copy">
                  <strong>{option.name}</strong>
                  <span>
                    {option.colorSchemeLabel}
                    {option.sourceLabel ? <em>{option.sourceLabel}</em> : null}
                  </span>
                </span>
                <span className="ling-ui-theme-option-state" aria-hidden="true">
                  {applying ? <Spinner label={applyingLabel} size="sm" /> : null}
                  {!applying && selected ? <Check /> : null}
                  {!applying && !selected && active ? <span className="ling-ui-theme-option-active-dot" /> : null}
                </span>
              </span>
              {option.disabledReason ? (
                <span className="ling-ui-theme-option-reason">{option.disabledReason}</span>
              ) : null}
            </ToggleGroupPrimitive.Item>
            {option.actions ? (
              <span className="ling-ui-theme-option-actions">{option.actions}</span>
            ) : null}
          </span>
        );
      })}
    </ToggleGroupPrimitive.Root>
  );
});

function ThemeOptionSwatch({ swatch }: { readonly swatch: ThemePickerSwatch }): React.JSX.Element {
  const style = {
    "--ling-theme-option-accent": swatch.accent,
    "--ling-theme-option-app": swatch.app,
    "--ling-theme-option-danger": swatch.danger,
    "--ling-theme-option-info": swatch.info,
    "--ling-theme-option-panel": swatch.panel,
    "--ling-theme-option-success": swatch.success,
    "--ling-theme-option-text": swatch.text,
    "--ling-theme-option-warning": swatch.warning,
  } as CSSProperties;

  return (
    <span className="ling-ui-theme-option-swatch" style={style} aria-hidden="true">
      <span className="ling-ui-theme-option-swatch-app">
        <span className="ling-ui-theme-option-swatch-text" />
        <span className="ling-ui-theme-option-swatch-accent" />
      </span>
      <span className="ling-ui-theme-option-swatch-panel">
        <span className="ling-ui-theme-option-swatch-status" data-tone="success" />
        <span className="ling-ui-theme-option-swatch-status" data-tone="warning" />
        <span className="ling-ui-theme-option-swatch-status" data-tone="danger" />
        <span className="ling-ui-theme-option-swatch-status" data-tone="info" />
      </span>
    </span>
  );
}
