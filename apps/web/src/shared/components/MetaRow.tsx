export function MetaRow({
  label,
  value,
  compact = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly compact?: boolean;
}): React.JSX.Element {
  return (
    <div className={compact ? "meta-row compact" : "meta-row"}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
