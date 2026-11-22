export interface RemoteSocketMessageEvent {
  readonly data: unknown;
}

export interface RemoteSocketCloseEvent {
  readonly code?: number;
  readonly reason?: string;
}

export interface RemoteWebSocketLike {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: RemoteSocketMessageEvent) => void): void;
  addEventListener(type: "close", listener: (event: RemoteSocketCloseEvent) => void): void;
  addEventListener(type: "error", listener: () => void): void;
}

export interface RemoteMessageReceiver {
  opened?(): void;
  received(data: unknown): void;
  closed(event: RemoteSocketCloseEvent): void;
  failed(): void;
}

/** One ordered application receiver, switched from authentication to session processing. */
export interface RemoteMessageChannel {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  subscribe(receiver: RemoteMessageReceiver): () => void;
}

export function remoteWebSocketChannel(socket: RemoteWebSocketLike): RemoteMessageChannel {
  let receiver: RemoteMessageReceiver | undefined;
  socket.addEventListener("open", () => receiver?.opened?.());
  socket.addEventListener("message", event => receiver?.received(event.data));
  socket.addEventListener("close", event => receiver?.closed(event));
  socket.addEventListener("error", () => receiver?.failed());
  return {
    get readyState() { return socket.readyState; },
    get bufferedAmount() { return socket.bufferedAmount ?? 0; },
    send(data) { socket.send(data); },
    close(code, reason) { socket.close(code, reason); },
    subscribe(next) {
      if (receiver) throw new Error("remote_channel_already_subscribed");
      receiver = next;
      return () => {
        if (receiver === next) receiver = undefined;
      };
    },
  };
}
