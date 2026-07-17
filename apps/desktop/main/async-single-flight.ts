export class AsyncSingleFlight<T> {
  private active: Promise<T> | undefined;

  run(operation: () => Promise<T>): Promise<T> {
    if (this.active) {
      return this.active;
    }
    const active = operation();
    this.active = active;
    void active.finally(() => {
      if (this.active === active) {
        this.active = undefined;
      }
    }).catch(() => undefined);
    return active;
  }
}
