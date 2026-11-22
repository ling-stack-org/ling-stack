import { spawn, type ChildProcessByStdio } from "node:child_process";
import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { REMOTE_PROTOCOL_LIMITS } from "@ling-stack/contracts";
import { isRecord } from "../../shared/validation.js";

const maxFrameBytes = REMOTE_PROTOCOL_LIMITS.maxFrameBytes;
const maxLineChars = 6 * maxFrameBytes + 4096;
const maxBufferedBytes = 4 * maxFrameBytes;
const peerStates = new Set(["new", "connecting", "connected", "disconnected", "failed", "closed"]);

interface PendingRequest {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
}

const executableName = process.platform === "win32" ? "ling-peer-worker.exe" : "ling-peer-worker";

export function resolvePionPeerWorker(): string | undefined {
  const candidate = process.env.LING_PEER_WORKER_PATH
    ?? fileURLToPath(new URL("../../native/ling-peer-worker/" + executableName, import.meta.url));
  if (!isAbsolute(candidate) || basename(candidate) !== executableName || candidate.includes("\0")) return undefined;
  try {
    const stat = lstatSync(candidate);
    if (!stat.isFile() || stat.size < 1 || stat.size > 32 * 1024 * 1024) return undefined;
    accessSync(candidate, constants.X_OK);
    return realpathSync(candidate);
  } catch {
    return undefined;
  }
}

export function createPionPeerConnectionFactory(executable: string): (configuration: RTCConfiguration) => RTCPeerConnection {
  return configuration => new PionPeerConnection(executable, configuration) as unknown as RTCPeerConnection;
}

class PionPeerConnection extends EventTarget {
  readonly #worker: ChildProcessByStdio<Writable, Readable, null>;
  readonly #pending = new Map<number, PendingRequest>();
  #connectionState: RTCPeerConnectionState = "new";
  #channel?: PionDataChannel;
  #nextId = 1;
  #input = "";
  #closed = false;

  constructor(executable: string, configuration: RTCConfiguration) {
    super();
    this.#worker = spawn(executable, [], {
      windowsHide: true, shell: false, stdio: ["pipe", "pipe", "ignore"],
      env: process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {},
    });
    this.#worker.stdout.setEncoding("utf8");
    this.#worker.stdout.on("data", (data: string) => this.read(data));
    this.#worker.stdout.on("error", () => this.fail());
    this.#worker.stdin.on("error", () => this.fail());
    this.#worker.once("error", () => this.fail());
    this.#worker.once("close", () => this.fail());
    void this.request("initialize", { configuration }).catch(() => this.fail());
  }

  get connectionState(): RTCPeerConnectionState {
    return this.#connectionState;
  }

  createDataChannel(label: string, options: RTCDataChannelInit): RTCDataChannel {
    if (this.#channel || label !== "ling-peer" || options.protocol !== "ling-peer.v1" || options.ordered !== true
      || options.maxRetransmits != null || options.maxPacketLifeTime != null
      || (options.negotiated ? options.id !== 0 : options.id !== undefined)) {
      throw new Error("ling_peer_worker_channel_invalid");
    }
    this.#channel = new PionDataChannel(this);
    void this.request("open_channel", { negotiated: options.negotiated === true }).catch(() => this.fail());
    return this.#channel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return this.description("offer");
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return this.description("answer");
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    await this.request("set_local_description", { description });
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    await this.request("set_remote_description", { description });
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    await this.request("add_candidate", { candidate });
  }

  async send(text: string): Promise<void> {
    await this.request("send", { text });
  }

  close(): void {
    this.finish("closed");
  }

  private async description(type: "offer" | "answer"): Promise<RTCSessionDescriptionInit> {
    const description = await this.request(type === "offer" ? "create_offer" : "create_answer");
    if (!isRecord(description) || description.type !== type || typeof description.sdp !== "string") {
      throw new Error("ling_peer_worker_description_invalid");
    }
    return { type, sdp: description.sdp };
  }

  private request(type: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (this.#closed || this.#pending.size >= 32) return Promise.reject(new Error("ling_peer_worker_unavailable"));
    const id = this.#nextId++;
    const line = JSON.stringify({ id, type, ...args }) + "\n";
    if (line.length > maxLineChars || this.#worker.stdin.writableLength + Buffer.byteLength(line) > 2 * maxLineChars) {
      return Promise.reject(new Error("ling_peer_worker_queue_full"));
    }
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.stdin.write(line, error => { if (error) this.fail(); });
    });
  }

  private read(chunk: string): void {
    if (this.#closed) return;
    this.#input += chunk;
    let newline = this.#input.indexOf("\n");
    while (newline >= 0) {
      if (newline > maxLineChars) return this.fail();
      const line = this.#input.slice(0, newline);
      this.#input = this.#input.slice(newline + 1);
      try {
        this.onMessage(JSON.parse(line));
      } catch {
        return this.fail();
      }
      if (this.#closed) return;
      newline = this.#input.indexOf("\n");
    }
    if (this.#input.length > maxLineChars) this.fail();
  }

  private onMessage(event: unknown): void {
    if (!isRecord(event)) throw new Error("ling_peer_worker_event_invalid");
    if (event.type === "result" || event.type === "rejected") {
      const request = typeof event.id === "number" ? this.#pending.get(event.id) : undefined;
      if (!request) throw new Error("ling_peer_worker_reply_unexpected");
      this.#pending.delete(event.id as number);
      if (event.type === "rejected") request.reject(new Error("ling_peer_worker_request_rejected"));
      else request.resolve(event.value);
      return;
    }

    switch (event.type) {
      case "peer_state":
        if (typeof event.value !== "string" || !peerStates.has(event.value)) throw new Error("ling_peer_worker_state_invalid");
        this.#connectionState = event.value as RTCPeerConnectionState;
        this.dispatchEvent(new Event("connectionstatechange"));
        return;
      case "candidate": {
        const candidate = event.value;
        if (!isRecord(candidate) || typeof candidate.candidate !== "string") throw new Error("ling_peer_worker_candidate_invalid");
        this.dispatchEvent(Object.assign(new Event("icecandidate"), { candidate: { candidate: candidate.candidate, toJSON: () => candidate } }));
        return;
      }
      case "channel_open":
        this.#channel?.open();
        return;
      case "channel_closed":
        this.close();
        return;
      case "message":
        if (!this.#channel || typeof event.value !== "string" || Buffer.byteLength(event.value) > maxFrameBytes) {
          throw new Error("ling_peer_worker_frame_invalid");
        }
        this.#channel.dispatchEvent(new MessageEvent("message", { data: event.value }));
        return;
      default:
        this.fail();
    }
  }

  fail(): void {
    this.finish("failed");
  }

  private finish(state: "closed" | "failed"): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#connectionState = state;
    this.#input = "";
    const error = new Error("ling_peer_worker_unavailable");
    for (const job of this.#pending.values()) job.reject(error);
    this.#pending.clear();
    this.#worker.stdin.end();
    const timer = setTimeout(() => { if (this.#worker.exitCode === null) this.#worker.kill("SIGKILL"); }, 1000);
    timer.unref();
    this.#worker.once("close", () => clearTimeout(timer));
    this.dispatchEvent(new Event("connectionstatechange"));
    this.#channel?.finish();
  }
}

class PionDataChannel extends EventTarget {
  readyState: RTCDataChannelState = "connecting";
  bufferedAmount = 0;

  constructor(private readonly peer: PionPeerConnection) {
    super();
  }

  open(): void {
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
  }

  send(text: string): void {
    const bytes = Buffer.byteLength(text);
    if (this.readyState !== "open" || bytes > maxFrameBytes || this.bufferedAmount + bytes > maxBufferedBytes) {
      throw new Error("ling_peer_worker_channel_unavailable");
    }
    this.bufferedAmount += bytes;
    void this.peer.send(text).catch(() => this.peer.fail()).finally(() => { this.bufferedAmount -= bytes; });
  }

  close(): void {
    this.peer.close();
  }

  finish(): void {
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
}
