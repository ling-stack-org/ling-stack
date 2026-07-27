import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import type { ComponentPropsWithoutRef, ElementRef } from "react";
import { createContext, forwardRef, useContext, useRef, useState } from "react";
import { mergeClassNames } from "../shared/merge-class-names.js";

export type SegmentedControlSize = "sm" | "md";

const SegmentedControlSelectionContext = createContext<((value: string) => void) | null>(null);

export interface SegmentedControlProps extends Omit<
  ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root>,
  "defaultValue" | "onValueChange" | "type" | "value"
> {
  readonly defaultValue?: string;
  readonly onValueChange?: (value: string) => void;
  readonly size?: SegmentedControlSize;
  readonly value?: string;
}

export const SegmentedControl = forwardRef<
  ElementRef<typeof ToggleGroupPrimitive.Root>,
  SegmentedControlProps
>(function SegmentedControl(
  { className, defaultValue, onValueChange, size = "md", value, ...props },
  ref,
) {
  const [internalValue, setInternalValue] = useState(defaultValue ?? "");
  const selectedValue = value ?? internalValue;
  const selectedValueRef = useRef(selectedValue);
  selectedValueRef.current = selectedValue;
  const selectValue = (nextValue: string): void => {
    if (!nextValue || nextValue === selectedValueRef.current) return;
    selectedValueRef.current = nextValue;
    if (value === undefined) setInternalValue(nextValue);
    onValueChange?.(nextValue);
  };

  return (
    <SegmentedControlSelectionContext.Provider value={selectValue}>
      <ToggleGroupPrimitive.Root
        {...props}
        ref={ref}
        type="single"
        className={mergeClassNames("ling-ui-segmented-control", className)}
        data-size={size}
        value={selectedValue}
        onValueChange={selectValue}
      />
    </SegmentedControlSelectionContext.Provider>
  );
});

export const SegmentedControlItem = forwardRef<
  ElementRef<typeof ToggleGroupPrimitive.Item>,
  ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item>
>(function SegmentedControlItem({ className, onFocus, value, ...props }, ref) {
  const selectValue = useContext(SegmentedControlSelectionContext);
  return (
    <ToggleGroupPrimitive.Item
      {...props}
      ref={ref}
      className={mergeClassNames("ling-ui-segmented-control-item", className)}
      data-value={value}
      value={value}
      onFocus={(event) => {
        onFocus?.(event);
        if (!event.defaultPrevented) selectValue?.(value);
      }}
    />
  );
});
