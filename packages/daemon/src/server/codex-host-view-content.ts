export const codexHostViewHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ling and Codex</title>
  <link rel="stylesheet" href="/view.css">
  <script defer src="/view.js"></script>
</head>
<body>
  <main>
    <header>
      <h1>Ling and Codex</h1>
      <p id="connection" role="status">Connecting</p>
    </header>
    <div class="sessions">
      <section aria-labelledby="ling-heading">
        <h2 id="ling-heading">Ling</h2>
        <p id="ling-title"></p>
        <p id="ling-turn">Waiting for the session</p>
        <p id="ling-requests" role="status"></p>
        <form id="ling-input">
          <label for="ling-message">Message for Ling</label>
          <textarea id="ling-message" required maxlength="16384" rows="3"></textarea>
          <button id="ling-queue" disabled>Queue message</button>
          <button type="button" class="secondary" id="ling-interrupt" disabled>Interrupt turn</button>
        </form>
      </section>
      <section aria-labelledby="codex-heading">
        <h2 id="codex-heading">Codex</h2>
        <p id="codex-turn">Waiting for the session</p>
        <form id="codex-input">
          <label for="codex-message">Message for Codex</label>
          <textarea id="codex-message" required maxlength="16384" rows="3"></textarea>
          <button id="codex-start" disabled>Start turn</button>
        </form>
        <form id="steer-input">
          <label for="ling-event">Ling event</label>
          <select id="ling-event"></select>
          <button id="codex-steer" disabled>Send event to Codex</button>
        </form>
      </section>
    </div>
    <p id="command-status" role="status"></p>
    <section aria-labelledby="activity-heading">
      <h2 id="activity-heading">Activity</h2>
      <ol id="activity" aria-labelledby="activity-heading"></ol>
    </section>
  </main>
</body>
</html>`;

export const codexHostViewStyles = `
  :root { color-scheme: light dark; font: 15px/1.5 system-ui, sans-serif; color: CanvasText; background: Canvas; }
  * { box-sizing: border-box; }
  body { margin: 0; }
  main { width: min(100% - 2rem, 59rem); margin: 2rem auto; }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
  h1 { font-size: 1.8rem; margin: 0 0 1rem; }
  h2 { font-size: 1.1rem; margin: 0 0 .5rem; }
  p { margin: .35rem 0; overflow-wrap: anywhere; }
  #connection { color: GrayText; }
  .sessions { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(24rem, 100%), 1fr)); gap: .9rem; }
  section { padding: 1rem; border: 1px solid color-mix(in srgb, CanvasText 22%, Canvas); border-radius: .75rem; }
  form { margin-top: .75rem; }
  label { display: block; font-weight: 600; margin-bottom: .3rem; }
  textarea, select { width: 100%; margin-bottom: .55rem; font: inherit; padding: .4rem .55rem; border-radius: .4rem; }
  textarea { resize: vertical; }
  button { cursor: pointer; font: inherit; font-weight: 600; padding: .45rem .7rem; color: #fff; background: #355fba; border: 1px solid transparent; border-radius: .45rem; }
  .secondary { color: CanvasText; background: Canvas; border-color: GrayText; }
  button:disabled { opacity: .5; cursor: default; }
  :focus-visible { outline: 2px solid #6d91ee; outline-offset: 2px; }
  #command-status { min-height: 1.5rem; margin: .6rem 0; }
  #activity { list-style: none; padding: 0; margin: 0; max-height: 18rem; overflow: auto; }
  #activity li { display: flex; gap: 1rem; border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, Canvas); padding: .35rem 0; }
  #activity strong { flex-basis: 4rem; flex-shrink: 0; }
`;

export const codexHostViewScript = String.raw`
const find = id => document.getElementById(id);
const fragment = location.hash.slice(1);
if (/^[a-f0-9]{64}$/.test(fragment)) {
  sessionStorage.setItem("codex-host-access", fragment);
  history.replaceState(null, "", location.pathname);
}
const access = sessionStorage.getItem("codex-host-access");
const headers = { Authorization: "Bearer " + access };
const activity = find("activity"), eventPicker = find("ling-event");
const connection = find("connection"), commandStatus = find("command-status");
const lingActive = new Set(["open", "queued", "running", "waiting_for_approval", "waiting_for_input"]);
let sequence = 0, connected = false, busy = false, refreshTimer;
let lingScopeRevision = 0, codexTurnSequence = 0;
let ling, codexThreadId, codexTurnId, codexStatus, queuedMessage;

function controls() {
  const usable = connected && !busy;
  find("ling-queue").disabled = !usable || !lingActive.has(ling?.turn?.status);
  find("ling-interrupt").disabled = !usable || !lingActive.has(ling?.turn?.status);
  find("codex-start").disabled = !usable || Boolean(codexTurnId) || codexStatus === "closed";
  find("codex-steer").disabled = !usable || !codexTurnId || !eventPicker.value;
  find("codex-turn").textContent = codexStatus === "closed" ? "Disconnected" : codexTurnId ? "Turn running" : "Ready";
}

async function command(method, params) {
  const response = await fetch("/command", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message ?? value.error ?? "Command failed.");
  return value.result;
}

async function readLing() {
  const revision = lingScopeRevision;
  const snapshot = await command("ling/snapshot").catch(error => {
    if (revision === lingScopeRevision) clearLing();
    throw error;
  });
  if (revision !== lingScopeRevision) throw new Error("Ling session access changed.");
  ling = snapshot;
  find("ling-title").textContent = snapshot.thread.title;
  const status = snapshot.turn?.status;
  find("ling-turn").textContent = status ? "Turn " + status.replaceAll("_", " ") : "No active turn";
  const approvals = snapshot.pendingApprovals.length, inputs = snapshot.pendingInputs.length;
  find("ling-requests").textContent = [approvals ? approvals + " pending approvals" : "", inputs ? inputs + " pending questions" : ""]
    .filter(Boolean).join(" · ");
  controls();
  return snapshot;
}

function clearLing() {
  ling = undefined;
  find("ling-title").textContent = "";
  find("ling-turn").textContent = "Waiting for Ling";
  find("ling-requests").textContent = "";
  eventPicker.replaceChildren();
  controls();
}

async function readCodex() {
  const revision = codexTurnSequence;
  const snapshot = await command("codex/snapshot");
  if (revision !== codexTurnSequence) return;
  codexThreadId = snapshot.thread.id;
  const lastTurn = snapshot.thread.turns?.at(-1);
  codexTurnId = lastTurn?.status === "inProgress" ? lastTurn.id : undefined;
  controls();
}

function showEvent(event) {
  if (event.sequence <= sequence) return;
  sequence = event.sequence;
  if (event.resetLing) {
    lingScopeRevision++;
    clearLing();
    for (const entry of activity.querySelectorAll('[data-source="ling"]')) entry.remove();
  }
  const label = event.source === "ling" ? "Ling" : event.source === "codex" ? "Codex" : "Host";
  const entry = document.createElement("li"), source = document.createElement("strong"), detail = document.createElement("span");
  entry.dataset.source = event.source;
  source.textContent = label;
  detail.textContent = event.method.replaceAll("/", " · ") + (event.state ? " · " + event.state.replaceAll("_", " ") : "");
  entry.append(source, detail);
  activity.prepend(entry);
  if (activity.children.length > 40) activity.lastElementChild.remove();
  if (event.eventId && event.source === "ling" && !Array.from(eventPicker.options).some(item => item.value === event.eventId)) {
    const option = new Option(event.method + " · " + event.eventId.slice(-10), event.eventId);
    const selected = eventPicker.value;
    eventPicker.prepend(option);
    if (!selected) eventPicker.value = option.value;
    if (eventPicker.length > 30) eventPicker.remove(eventPicker.length - 1);
  }
  if (event.codexThreadId) {
    codexThreadId = event.codexThreadId;
    void readCodex().catch(() => {});
  }
  if (event.source === "codex") {
    if (event.method === "turn/started") {
      codexTurnSequence = sequence;
      codexTurnId = event.turnId;
    }
    if (event.method === "turn/completed" && event.turnId === codexTurnId) {
      codexTurnSequence = sequence;
      codexTurnId = undefined;
    }
    if (event.method === "connection/status") codexStatus = event.state;
  }
  if (event.source === "ling" && /^(turn|approval|input|connection)\//.test(event.method)) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void readLing().catch(() => {}), 150);
  }
  controls();
}

async function observe() {
  if (!access) { connection.textContent = "Open the private URL printed by the Codex host."; return; }
  for (;;) {
    try {
      const response = await fetch("/events?after=" + sequence, { headers });
      if (response.status === 401) { connection.textContent = "This view session has expired."; return; }
      if (!response.ok || !response.body) throw new Error("Stream unavailable");
      connected = true;
      connection.textContent = "Connected";
      controls();
      void readLing().catch(() => {});
      if (codexThreadId) void readCodex().catch(() => {});
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let line = "";
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          const lines = (line + chunk.value).split("\n");
          line = lines.pop();
          for (const next of lines) if (next) showEvent(JSON.parse(next));
        }
      } finally { await reader.cancel().catch(() => {}); }
    } catch {
      // Reconnect with the highest rendered event sequence.
    }
    connected = false;
    connection.textContent = "Reconnecting";
    controls();
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

function perform(action) {
  return async event => {
    event.preventDefault();
    if (!connected || busy) return;
    busy = true;
    controls();
    commandStatus.textContent = "Sending";
    try {
      commandStatus.textContent = await action();
    } catch (error) {
      commandStatus.textContent = error.message;
    } finally {
      busy = false;
      controls();
    }
  };
}

async function activeLingTurn() {
  const { turn } = await readLing();
  if (!lingActive.has(turn?.status)) throw new Error("Ling has no active turn.");
  return { expectedTurnId: turn.id, expectedTurnRevision: turn.updatedAt };
}

find("ling-input").addEventListener("submit", perform(async () => {
  const turn = await activeLingTurn(), field = find("ling-message");
  const message = field.value.trim();
  if (!message) throw new Error("Enter a message for Ling.");
  const basis = JSON.stringify([turn, message]);
  if (queuedMessage?.basis !== basis) queuedMessage = { basis, key: crypto.randomUUID() };
  await command("ling/queue", { ...turn, message, idempotencyKey: queuedMessage.key });
  queuedMessage = undefined;
  field.value = "";
  return "Message queued for Ling.";
}));
find("ling-interrupt").addEventListener("click", perform(async () => {
  await command("ling/interrupt", await activeLingTurn());
  return "Interrupt accepted.";
}));
find("codex-input").addEventListener("submit", perform(async () => {
  const field = find("codex-message"), message = field.value.trim();
  if (!message) throw new Error("Enter a message for Codex.");
  if (!codexThreadId) codexThreadId = (await command("codex/thread/start")).threadId;
  const { turn } = await command("codex/turn/start", { message });
  if (turn.status === "inProgress") codexTurnId = turn.id;
  field.value = "";
  return "Codex turn accepted.";
}));
eventPicker.addEventListener("change", controls);
find("steer-input").addEventListener("submit", perform(async () => {
  const result = await command("codex/steer", { expectedTurnId: codexTurnId, eventId: eventPicker.value });
  if (result.status === "accepted") return "Event delivered to Codex.";
  if (result.status === "rejected") return "Codex rejected the event.";
  return "Delivery could not be confirmed. Check the Codex turn.";
}));
void observe();
`;
