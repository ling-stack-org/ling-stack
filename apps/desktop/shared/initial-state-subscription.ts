export function subscribeWithInitialRead<T>(input: {
  readonly read: () => Promise<T>;
  readonly subscribe: (listener: (value: T) => void) => () => void;
  readonly onValue: (value: T) => void;
}): () => void {
  let active = true;
  let liveValueSeen = false;
  const unsubscribe = input.subscribe((value) => {
    if (!active) {
      return;
    }
    liveValueSeen = true;
    input.onValue(value);
  });
  void input.read().then((value) => {
    if (active && !liveValueSeen) {
      input.onValue(value);
    }
  }).catch(() => undefined);
  return () => {
    if (!active) {
      return;
    }
    active = false;
    unsubscribe();
  };
}
