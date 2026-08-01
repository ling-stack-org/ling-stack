import { StatusBar } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { PairingGate } from "./src/features/pairing/PairingGate";
import { MobileConversationNavigator } from "./src/navigation/MobileConversationNavigator";
import { MobileRemoteProvider, useMobileRemote } from "./src/remote/MobileRemoteProvider";
import { MobileThemeProvider, useMobileTheme } from "./src/theme/mobile-theme-provider";

export default function App() {
  return (
    <SafeAreaProvider>
      <MobileThemeProvider>
        <MobileRemoteProvider>
          <MobileAppRoot />
        </MobileRemoteProvider>
      </MobileThemeProvider>
    </SafeAreaProvider>
  );
}

function MobileAppRoot() {
  const { phase } = useMobileRemote();
  const { theme } = useMobileTheme();
  return (
    <>
      <StatusBar barStyle={theme.mode === "dark" ? "light-content" : "dark-content"} />
      {phase === "paired" ? <MobileConversationNavigator /> : <PairingGate />}
    </>
  );
}
