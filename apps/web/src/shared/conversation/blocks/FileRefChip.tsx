import type { ReactNode } from "react";

export interface FileRefChipProps {
  readonly label: string;
  readonly meta?: string;
  readonly icon?: ReactNode;
}

export function FileRefChip({ label, meta, icon }: FileRefChipProps): JSX.Element {
  return (
    <span className="file-ref-chip">
      {icon}
      <span>{label}</span>
      {meta ? <small>{meta}</small> : null}
    </span>
  );
}
