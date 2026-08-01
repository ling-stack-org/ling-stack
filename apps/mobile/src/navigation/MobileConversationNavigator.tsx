import { NavigationContainer, DarkTheme, DefaultTheme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";

import { ConversationDetailScreen } from "../features/conversations/screens/ConversationDetailScreen";
import { ConversationIndexScreen } from "../features/conversations/screens/ConversationIndexScreen";
import { MyScreen } from "../features/profile/MyScreen";
import { useMobileTheme } from "../theme/mobile-theme-provider";
import type { MobileStackParamList } from "./types";

const Stack = createNativeStackNavigator<MobileStackParamList>();

export function MobileConversationNavigator() {
  const { theme } = useMobileTheme();
  const navigationTheme = {
    ...(theme.mode === "dark" ? DarkTheme : DefaultTheme),
    colors: {
      ...(theme.mode === "dark" ? DarkTheme.colors : DefaultTheme.colors),
      background: theme.background.app,
      card: theme.background.panel,
      text: theme.text.default,
      border: theme.border.default,
      primary: theme.action.accent,
      notification: theme.status.info,
    },
  };
  return (
    <NavigationContainer theme={navigationTheme}>
      <Stack.Navigator screenOptions={{ headerShown: false, animation: "slide_from_right" }}>
        <Stack.Screen component={ConversationIndexScreen} name="Conversations" />
        <Stack.Screen component={ConversationDetailScreen} name="ConversationDetail" />
        <Stack.Screen component={MyScreen} name="My" />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
