import {
  DeviceCapabilityBroker,
  SqliteDeviceDeveloperStore,
  SqliteDeviceFabricStore,
  SqliteDeviceSupportStore,
} from "@ling-stack/core";
import { createRemoteDeviceFacade, type RemoteDeviceFacade } from "../remote-access/device-facade.js";

export interface DeviceSupportRuntime {
  readonly store: SqliteDeviceSupportStore;
  readonly fabricStore: SqliteDeviceFabricStore;
  readonly developerStore: SqliteDeviceDeveloperStore;
  readonly broker: DeviceCapabilityBroker;
  readonly remoteFacade: RemoteDeviceFacade;
  close(): void;
}

export function createDeviceSupportRuntime(options: { readonly databasePath: string; readonly now?: () => string }): DeviceSupportRuntime {
  const store = new SqliteDeviceSupportStore({ databasePath: options.databasePath });
  const fabricStore = new SqliteDeviceFabricStore({ databasePath: options.databasePath });
  const developerStore = new SqliteDeviceDeveloperStore({ databasePath: options.databasePath });
  const broker = new DeviceCapabilityBroker({ store, now: options.now });
  const remoteFacade = createRemoteDeviceFacade({ store, broker, now: options.now });
  return {
    store,
    fabricStore,
    developerStore,
    broker,
    remoteFacade,
    close: () => {
      fabricStore.close();
      developerStore.close();
      store.close();
    },
  };
}
