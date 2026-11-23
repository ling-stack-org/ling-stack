import AsyncStorage from "@react-native-async-storage/async-storage";
import { fetch } from "expo/fetch";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { AppState } from "react-native";

import { nativeSecureEntropy } from "../platform/secure-device-key/native-adapter";
import { openNativeLinuxSsh } from "../platform/native-linux-ssh";
import { nativeUsbModbus } from "../platform/native-usb-modbus";
import { nativeUsbAndroid } from "../platform/native-usb-android";
import { openPhoneTaskArtifactFile } from "../platform/phone-task-artifact-file";
import { createStandaloneDeviceRuntime, type StandaloneDeviceRuntime } from "./standalone-runtime";

type DeviceRuntimeState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly runtime: StandaloneDeviceRuntime }
  | { readonly status: "unavailable" };

const DeviceRuntimeContext = createContext<DeviceRuntimeState>({ status: "loading" });

export function StandaloneDeviceProvider({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState<DeviceRuntimeState>({ status: "loading" });
  useEffect(() => {
    let disposed = false;
    let appState = AppState.currentState;
    let runtime: StandaloneDeviceRuntime | undefined;
    const applyAppState = (nextState: typeof AppState.currentState) => {
      appState = nextState;
      if (!runtime) return;
      const activeRuntime = runtime;
      void activeRuntime.setForeground(nextState === "active").then(() => {
        if (!disposed) setState({ status: "ready", runtime: activeRuntime });
      }).catch(() => {
        if (!disposed) setState({ status: "unavailable" });
      });
    };
    const subscription = AppState.addEventListener("change", applyAppState);
    void createStandaloneDeviceRuntime({
      storage: AsyncStorage, randomId: nativeSecureEntropy.randomId, fetch, openLinuxSsh: openNativeLinuxSsh,
      usbModbus: nativeUsbModbus, usbAndroid: nativeUsbAndroid, openArtifactFile: openPhoneTaskArtifactFile,
    }).then(created => {
      if (disposed) return;
      runtime = created;
      applyAppState(appState);
    }).catch(() => {
      if (!disposed) setState({ status: "unavailable" });
    });
    return () => {
      disposed = true;
      subscription.remove();
      void runtime?.setForeground(false).catch(() => undefined);
    };
  }, []);
  return <DeviceRuntimeContext.Provider value={state}>{children}</DeviceRuntimeContext.Provider>;
}

export function useStandaloneDeviceRuntime(): DeviceRuntimeState {
  return useContext(DeviceRuntimeContext);
}
