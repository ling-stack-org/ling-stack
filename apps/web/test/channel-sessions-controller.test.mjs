import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Execute the production hook with deferred HTTP responses and deterministic
// render/effect commits. This checks state publication, without requiring a DOM.
let active;
globalThis.__channelSessionsControllerTest = {
  call: (name, ...args) => active[name](...args),
};
const stub = source => `data:text/javascript,${encodeURIComponent(source)}`;
const reactStub = stub(["useState", "useRef", "useEffect"].map(name =>
  `export const ${name} = (...args) => globalThis.__channelSessionsControllerTest.call('${name}', ...args);`
).join("\n"));
const apiStub = stub(["createChannelSession", "getChannelSession", "listChannelSessions", "updateChannelSession"].map(name =>
  `export const ${name} = (...args) => globalThis.__channelSessionsControllerTest.call('api', '${name}', ...args);`
).join("\n"));
const controllerUrl = new URL("../src/app/use-channel-sessions-controller.ts", import.meta.url).href;
const resolver = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === controllerUrl) {
    if (specifier === "react") return { url: reactStub, shortCircuit: true };
    if (specifier === "../api/channels.js") return { url: apiStub, shortCircuit: true };
    if (specifier === "./channel-session-state.js") {
      return { url: new URL("../src/app/channel-session-state.ts", import.meta.url).href, shortCircuit: true };
    }
  }
  return next(specifier, context);
} });
const { useChannelSessionsController } = await import(controllerUrl);
resolver.deregister();

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

function mount(api, selection = "session:shared-thread") {
  const slots = [], effects = [];
  const savedGlobals = { localStorage: globalThis.localStorage, window: globalThis.window };
  const storage = new Map();
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  let cursor = 0, dirty = false;
  const input = { cwd: "/workspace-A", channels: [], selectedChannelId: "shared-channel", selection, branches: [],
    setSelection: value => { input.selection = typeof value === "function" ? value(input.selection) : value; dirty = true; } };
  const harness = {
    current: undefined,
    api(name, ...args) { assert.ok(api[name], `Unexpected API: ${name}`); return api[name](...args); },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, value => {
        const next = typeof value === "function" ? value(slots[index].value) : value;
        if (!Object.is(next, slots[index].value)) { slots[index].value = next; dirty = true; }
      }];
    },
    useRef(value) { const index = cursor++; return slots[index] ??= { current: value }; },
    useEffect(effect, deps) {
      const index = cursor++, previous = slots[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        slots[index] = { deps, cleanup: previous?.cleanup };
        effects.push(() => { slots[index].cleanup?.(); slots[index].cleanup = effect(); });
      }
    },
    render() {
      active = harness;
      for (let commits = 0; commits < 20; commits++) {
        cursor = 0; dirty = false;
        // React gives each render its own props object; async closures keep it.
        harness.current = useChannelSessionsController({ ...input });
        while (effects.length) effects.shift()();
        if (!dirty) return;
      }
      assert.fail("Controller did not settle");
    },
    switchWorkspace(cwd) { input.cwd = cwd; harness.render(); },
    close() {
      for (const slot of slots) slot.cleanup?.();
      for (const [key, value] of Object.entries(savedGlobals)) {
        if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
      }
    },
  };
  harness.render();
  return harness;
}

const session = (title, activeRunIds = []) => ({ id: "shared-thread", channelId: "shared-channel", title, activeRunIds, pendingApprovalIds: [] });

test("a delayed existing-session lookup cannot overwrite a destination workspace sharing durable IDs", async () => {
  const response = deferred();
  const controller = mount({ getChannelSession: () => response.promise });
  try {
    const lookup = controller.current.ensureThread("shared-channel");
    controller.switchWorkspace("/workspace-B");
    const destination = session("B title");
    controller.current.select("shared-channel", destination);
    controller.render();
    assert.deepEqual(controller.current.selectedSession, destination);
    const rejected = assert.rejects(lookup, /Workspace changed/);
    response.resolve({ session: session("A private title", ["A-run"]) });
    await rejected;
    controller.render();
    assert.deepEqual(controller.current.selectedSession, destination);
  } finally { controller.close(); }
});

test("a delayed default-session fallback cannot return a send target after switching workspaces", async () => {
  const response = deferred();
  const controller = mount({ listChannelSessions: () => response.promise }, "");
  try {
    const lookup = controller.current.ensureThread("shared-channel");
    controller.switchWorkspace("/workspace-B");
    const rejected = assert.rejects(lookup, /Workspace changed/);
    response.resolve({ defaultSession: session("A default") });
    await rejected;
    assert.equal(controller.current.selectedSession, undefined);
  } finally { controller.close(); }
});

test("current-workspace lookups still publish active sessions and reject archived sessions", async () => {
  let result = session("A title");
  const controller = mount({ getChannelSession: async () => ({ session: result }), listChannelSessions: async () => ({ defaultSession: result }) });
  try {
    assert.deepEqual((await controller.current.ensureThread("shared-channel")).session, result);
    controller.render();
    assert.deepEqual(controller.current.selectedSession, result);
    assert.deepEqual((await controller.current.ensureThread("shared-channel", "")).session, result);
    result = { ...result, archivedAt: "2026-10-29T00:00:00.000Z" };
    await assert.rejects(controller.current.ensureThread("shared-channel"), /archived/);
    await assert.rejects(controller.current.ensureThread("shared-channel", ""), /unavailable/);
  } finally { controller.close(); }
});
