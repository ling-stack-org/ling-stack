/** Deterministic test hook port; production controller callbacks/conditions remain unchanged. */
export function catalogHookPort() {
  const cells = [];
  let cursor = 0;
  let queued = [];
  const same = (left, right) => Boolean(left && right && left.length === right.length && left.every((value, i) => Object.is(value, right[i])));
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!cells[i]) cells[i] = { value: typeof initial === "function" ? initial() : initial };
      return [cells[i].value, value => { cells[i].value = typeof value === "function" ? value(cells[i].value) : value; }];
    },
    useRef(initial) {
      const i = cursor++;
      if (!cells[i]) cells[i] = { value: { current: initial } };
      return cells[i].value;
    },
    useMemo(callback, deps) {
      const i = cursor++;
      if (!cells[i] || !same(cells[i].deps, deps)) cells[i] = { value: callback(), deps };
      return cells[i].value;
    },
    useCallback(callback, deps) { return hooks.useMemo(() => callback, deps); },
    useEffect(callback, deps) {
      const i = cursor++;
      if (!cells[i] || !same(cells[i].deps, deps)) {
        const previous = cells[i];
        cells[i] = { deps, cleanup: previous?.cleanup };
        queued.push(() => { cells[i].cleanup?.(); cells[i].cleanup = callback(); });
      }
    },
  };
  return {
    hooks,
    render(callback, input) { cursor = 0; return callback(input); },
    async flush() {
      const effects = queued;
      queued = [];
      for (const effect of effects) effect();
      // Controller IO ports use resolved Promises; drain their continuations without timers.
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    },
  };
}
