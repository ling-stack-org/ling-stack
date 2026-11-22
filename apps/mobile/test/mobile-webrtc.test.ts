import assert from "node:assert/strict";
import test from "node:test";
import {
  createMobilePeerConnectionFactoryFromRuntime,
} from "../src/remote/mobile-webrtc.ts";

test("mobile WebRTC peer factory uses the native runtime and preserves ICE configuration", () => {
  const seen: RTCConfiguration[] = [];
  class FakePeerConnection {
    readonly configuration: RTCConfiguration | undefined;
    constructor(configuration?: RTCConfiguration) {
      this.configuration = configuration;
      if (configuration) seen.push(configuration);
    }
  }
  const factory = createMobilePeerConnectionFactoryFromRuntime({
    RTCPeerConnection: FakePeerConnection as unknown as typeof RTCPeerConnection,
  });
  const configuration = { iceTransportPolicy: "relay" } as RTCConfiguration;
  const peer = factory(configuration) as unknown as FakePeerConnection;
  assert.equal(peer.configuration, configuration);
  assert.deepEqual(seen, [configuration]);
});

test("mobile WebRTC peer factory rejects a missing native constructor", () => {
  assert.throws(
    () => createMobilePeerConnectionFactoryFromRuntime({ RTCPeerConnection: undefined as never }),
    /mobile_webrtc_native_module_unavailable/u,
  );
});
