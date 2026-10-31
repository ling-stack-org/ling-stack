import { EventEmitter, once } from "node:events";
import { PassThrough, Writable } from "node:stream";

/** Real Writable machinery with explicitly controlled _write completion. */
export class ControlledLeaseWritable extends Writable {
  constructor() {
    super({ autoDestroy: false });
    this.requests = [];
    this.destroyCalls = 0;
  }

  _write(frame, encoding, callback) {
    const request = { frame: frame.toString(), complete: callback };
    this.requests.push(request);
    this.emit("requestAvailable");
  }

  _destroy(error, callback) {
    this.destroyCalls += 1;
    callback(error);
  }

  async nextWrite() {
    if (this.requests.length === 0) await once(this, "requestAvailable");
    const request = this.requests.shift();
    if (request === undefined) throw new Error("controlled writer request missing");
    return request;
  }
}

/** No OS process or signal: observes the production child lifecycle port. */
export class ControlledLeaseChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 910_001;
    this.exitCode = null;
    this.signalCode = null;
    this.stdin = new ControlledLeaseWritable();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killCalls = [];
    this.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      outcome: "locked",
      platform: process.platform === "darwin" ? "darwin" : "win32",
      reason: "locked",
      nativeCode: 0,
      parentIdentity: "1:1",
      lockScope: "parent",
      recoveredAbandonedLock: false,
    })}\n`);
  }

  kill(signal) {
    this.killCalls.push(signal);
    this.emit("terminationRequested");
    return true;
  }

  finishExit({ code = null, signal = "SIGKILL" } = {}) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", code, signal);
  }

  receipt(request, outcome) {
    const fields = request.frame.trimEnd().split("\t");
    const release = fields[1] === "release";
    this.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      outcome,
      platform: process.platform === "darwin" ? "darwin" : "win32",
      reason: outcome,
      nativeCode: 0,
      requestId: Number(fields[2]),
      operation: release ? "release" : fields[3],
      operationOwnerPid: this.pid,
      ...(release ? {
        parentIdentity: "1:1",
        lockScope: "parent",
        recoveredAbandonedLock: false,
      } : {}),
    })}\n`);
  }
}

export function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

/** Flush explicit Promise/nextTick callbacks, not an OS timing assumption. */
export function nextEventLoopTurn() {
  return new Promise(resolve => setImmediate(resolve));
}
