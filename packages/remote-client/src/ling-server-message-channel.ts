import { REMOTE_PROTOCOL_LIMITS } from "@ling-stack/contracts";
import { encodeUtf8, type RemoteMessageChannel, type RemoteMessageReceiver } from "@ling-stack/remote-protocol";

const earlyFrameLimit = 8;
const maxFrameBytes = REMOTE_PROTOCOL_LIMITS.maxFrameBytes;

export function lingServerMessageChannel(peer: RTCPeerConnection, channel: RTCDataChannel): RemoteMessageChannel {
  let receiver: RemoteMessageReceiver | undefined;
  let earlyBytes = 0;
  let closed = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const earlyFrames: string[] = [];

  const finish = () => {
    if (closed) return;
    closed = true;
    clearTimeout(closeTimer);
    earlyFrames.length = 0;
    channel.removeEventListener("message", receive);
    channel.removeEventListener("error", fail);
    channel.removeEventListener("close", finish);
    peer.removeEventListener("connectionstatechange", checkConnection);
    const previous = receiver;
    receiver = undefined;
    peer.close();
    previous?.closed({});
  };
  const close = () => {
    if (closed) return;
    channel.close();
    // Give the DataChannel a chance to flush the final application frame before releasing DTLS.
    if (!closed) closeTimer ??= setTimeout(finish, 1_000);
  };
  const fail = () => {
    receiver?.failed();
    close();
  };
  const checkConnection = () => {
    if (peer.connectionState === "failed") fail();
    if (peer.connectionState === "closed") finish();
  };
  const receive = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (typeof data !== "string" || data.length > maxFrameBytes) {
      fail();
      return;
    }
    const bytes = encodeUtf8(data).length;
    if (bytes > maxFrameBytes) {
      fail();
      return;
    }
    if (receiver && earlyFrames.length === 0) {
      receiver.received(data);
      return;
    }
    if (earlyFrames.length >= earlyFrameLimit || earlyBytes + bytes > maxFrameBytes) {
      fail();
      return;
    }
    earlyFrames.push(data);
    earlyBytes += bytes;
  };

  channel.addEventListener("message", receive);
  channel.addEventListener("error", fail);
  channel.addEventListener("close", finish);
  peer.addEventListener("connectionstatechange", checkConnection);
  return {
    get readyState() {
      if (closed) return 3;
      switch (channel.readyState) {
        case "connecting": return 0;
        case "open": return 1;
        case "closing": return 2;
        case "closed": return 3;
      }
    },
    get bufferedAmount() { return channel.bufferedAmount; },
    send(data) {
      if (data.length > maxFrameBytes || encodeUtf8(data).length > maxFrameBytes) throw new Error("remote_frame_too_large");
      channel.send(data);
    },
    close,
    subscribe(next) {
      if (receiver || closed) throw new Error("remote_channel_unavailable");
      receiver = next;
      queueMicrotask(() => {
        while (receiver === next && earlyFrames.length > 0) {
          const data = earlyFrames.shift()!;
          earlyBytes -= encodeUtf8(data).length;
          next.received(data);
        }
      });
      return () => {
        if (receiver === next) receiver = undefined;
      };
    },
  };
}
