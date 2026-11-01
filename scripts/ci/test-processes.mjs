import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

function ps(args) {
  try {
    return execFileSync("ps", args, { encoding: "utf8", timeout: 5000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    // ps environment output can contain credentials. Never attach it to errors.
    throw new Error("Unable to inspect CI-owned test processes");
  }
}

function processTable() {
  return ps(["-axo", "pid=,ppid=,pgid=,stat=,lstart="]).trim().split(/\n/u).flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u.exec(line);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), state: match[4], started: match[5] }] : [];
  });
}

/** Track observed ancestry plus inherited ownership tags across setsid/reparenting.
 * This is test cleanup, not a sandbox for processes deliberately hiding ownership. */
export function trackTestProcesses(rootPid, token) {
  const owned = new Map();
  const marker = `LING_STACK_CI_TEST_OWNER=${token}`;
  function live(includeTagged = false) {
    if (!rootPid) return [];
    const table = processTable();
    const current = new Map(table.map(entry => [entry.pid, entry]));
    for (const [pid, started] of owned) if (current.get(pid)?.started !== started) owned.delete(pid);
    const tagged = new Set();
    if (includeTagged || owned.size === 0) {
      for (const line of ps(["eww", "-U", String(process.getuid()), "-o", "pid=,command="]).split(/\n/u)) {
        const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
        if (match && match[2].split(/\s+/u).includes(marker)) tagged.add(Number(match[1]));
      }
    }
    for (const entry of table) if (tagged.has(entry.pid)) owned.set(entry.pid, entry.started);
    // A numeric PGID alone is not ownership: require a still-identified member
    // before adopting its group, including when the original leader has exited.
    const originalGroup = table.some(entry => entry.group === rootPid && owned.get(entry.pid) === entry.started);
    if (originalGroup) for (const entry of table) if (entry.group === rootPid) owned.set(entry.pid, entry.started);
    let changed;
    do {
      changed = false;
      for (const entry of table) {
        if (!owned.has(entry.pid) && owned.has(entry.parent)) { owned.set(entry.pid, entry.started); changed = true; }
      }
    } while (changed);
    return table.filter(entry => owned.get(entry.pid) === entry.started && !entry.state.startsWith("Z"));
  }
  return {
    live,
    signal(signal) {
      for (const entry of live(true).reverse()) {
        try { process.kill(entry.pid, signal); }
        catch (error) {
          if (error.code !== "ESRCH" && !(error.code === "EPERM" && !live().some(value => value.pid === entry.pid))) throw error;
        }
      }
    },
    async waitForExit(timeoutMs) {
      const deadline = performance.now() + timeoutMs;
      while (live(true).length) {
        if (performance.now() >= deadline) return false;
        await delay(25);
      }
      return true;
    },
  };
}
