import { useState } from "react";
import { Modal, StatusBar } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { StandaloneDeviceProvider } from "./src/device/StandaloneDeviceProvider";
import { StandaloneDeviceScreen } from "./src/features/device-tasks/StandaloneDeviceScreen";
import { PairingGate } from "./src/features/pairing/PairingGate";
import { MobileConversationNavigator } from "./src/navigation/MobileConversationNavigator";
import { MobileRemoteProvider, useMobileRemote } from "./src/remote/MobileRemoteProvider";
import { MobileThemeProvider, useMobileTheme } from "./src/theme/mobile-theme-provider";

export default function App() {
  return (
    <SafeAreaProvider>
      <MobileThemeProvider>
        <MobileRemoteProvider>
          <StandaloneDeviceProvider>
            <MobileAppRoot />
          </StandaloneDeviceProvider>
        </MobileRemoteProvider>
      </MobileThemeProvider>
    </SafeAreaProvider>
  );
}

function MobileAppRoot() {
  const { phase } = useMobileRemote();
  const { theme } = useMobileTheme();
  const [showStandalone, setShowStandalone] = useState(false);
  const closeStandalone = () => setShowStandalone(false);
  return (
    <>
      <StatusBar barStyle={theme.mode === "dark" ? "light-content" : "dark-content"} />
      {phase === "paired" ? <MobileConversationNavigator /> : <PairingGate onOpenStandalone={() => setShowStandalone(true)} />}
      <Modal animationType="slide" onRequestClose={closeStandalone} visible={showStandalone}>
        <SafeAreaProvider>
          <StandaloneDeviceScreen onClose={closeStandalone} />
        </SafeAreaProvider>
      </Modal>
    </>
  );
}
