export function TeammateListSection<T>({
  icon,
  title,
  emptyLabel,
  items,
  renderItem,
}: {
  readonly icon: JSX.Element;
  readonly title: string;
  readonly emptyLabel: string;
  readonly items: readonly T[];
  readonly renderItem: (item: T) => JSX.Element;
}): JSX.Element {
  return (
    <section className="teammate-list-panel">
      <div className="panel-title split">
        <span>
          {icon}
          <h2>{title}</h2>
        </span>
        <small>{items.length}</small>
      </div>
      {items.length === 0 ? (
        <div className="client-empty-state teammate-empty">
          {icon}
          <span>{emptyLabel}</span>
        </div>
      ) : (
        <div className="teammate-data-list">{items.map(renderItem)}</div>
      )}
    </section>
  );
}
