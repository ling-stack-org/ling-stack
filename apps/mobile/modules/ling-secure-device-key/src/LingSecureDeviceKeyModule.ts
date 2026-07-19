import { requireNativeModule } from "expo";

import type { NativeSecureDeviceKeyModule } from "../../../src/platform/secure-device-key/types";

export default requireNativeModule<NativeSecureDeviceKeyModule>("LingSecureDeviceKey");
