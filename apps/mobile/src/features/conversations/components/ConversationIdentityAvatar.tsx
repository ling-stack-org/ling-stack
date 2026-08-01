import type { RemoteConversationSummaryV1 } from "@ling-stack/contracts";
import { Image, StyleSheet, Text, View } from "react-native";

import { useMobileTheme } from "../../../theme/mobile-theme-provider";
import { conversationGlyph } from "../domain/conversation-view-model";

export function ConversationIdentityAvatar({
  conversation,
  size = 42,
}: {
  readonly conversation: RemoteConversationSummaryV1;
  readonly size?: number;
}) {
  const { theme } = useMobileTheme();
  const round = conversation.kind === "teammate_direct";
  const radius = round ? size / 2 : Math.round(size * 0.31);
  const semanticStyle = conversation.kind === "conversation"
    ? { backgroundColor: theme.action.accent, borderColor: theme.action.accent }
    : conversation.kind === "teammate_direct"
      ? { backgroundColor: theme.identity.background, borderColor: theme.identity.background }
      : { backgroundColor: theme.background.subtle, borderColor: theme.border.default };
  const foreground = conversation.kind === "conversation"
    ? theme.action.foreground
    : conversation.kind === "teammate_direct"
      ? theme.identity.foreground
      : theme.text.strong;

  if (conversation.identity.avatarDataUrl) {
    return (
      <Image
        accessibilityLabel={conversation.identity.label}
        source={{ uri: conversation.identity.avatarDataUrl }}
        style={{ width: size, height: size, borderRadius: radius }}
      />
    );
  }

  return (
    <View
      accessibilityLabel={conversation.identity.label}
      style={[styles.avatar, semanticStyle, { width: size, height: size, borderRadius: radius }]}
    >
      <Text style={[styles.glyph, { color: foreground, fontSize: size >= 40 ? 17 : 14 }]}>
        {conversationGlyph(conversation)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: { alignItems: "center", justifyContent: "center", borderWidth: 1 },
  glyph: { fontWeight: "700" },
});
