/**
 * Loads the native React Native WebRTC implementation used by the signed
 * Ling Server DataChannel connector. The app must run in a native dev client
 * or release build. Expo Go cannot provide this module.
 */
export interface MobileWebRtcRuntime {
  readonly RTCPeerConnection: new (configuration?: RTCConfiguration) => RTCPeerConnection;
}

export async function loadMobileWebRtcRuntime(): Promise<MobileWebRtcRuntime> {
  const module = await import("react-native-webrtc").catch(() => undefined) as unknown as Partial<MobileWebRtcRuntime> | undefined;
  if (typeof module?.RTCPeerConnection !== "function") {
    throw new Error("mobile_webrtc_native_module_unavailable");
  }
  return module as MobileWebRtcRuntime;
}

export function createMobilePeerConnectionFactoryFromRuntime(
  runtime: MobileWebRtcRuntime,
): (configuration: RTCConfiguration) => RTCPeerConnection {
  if (typeof runtime.RTCPeerConnection !== "function") {
    throw new Error("mobile_webrtc_native_module_unavailable");
  }
  return configuration => new runtime.RTCPeerConnection(configuration);
}

export async function createMobilePeerConnectionFactory(): Promise<
  (configuration: RTCConfiguration) => RTCPeerConnection
> {
  return createMobilePeerConnectionFactoryFromRuntime(await loadMobileWebRtcRuntime());
}
