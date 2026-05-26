export function StatusBadge({ status }: { readonly status: string }): JSX.Element {
  return <span className={`status-badge ${status}`}>{status}</span>;
}
