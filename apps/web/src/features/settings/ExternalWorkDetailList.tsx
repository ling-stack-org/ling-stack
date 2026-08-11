export interface ExternalWorkDetailItem {
  readonly label: string;
  readonly value: string;
}

export function ExternalWorkDetailList({ items }: { readonly items: readonly ExternalWorkDetailItem[] }): React.JSX.Element {
  return (
    <dl className="settings-external-work-detail-list">
      {items.map((item) => (
        <div key={`${item.label}:${item.value}`}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
