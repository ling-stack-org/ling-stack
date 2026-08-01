import type { RemoteConversationSummaryV1 } from "@ling-stack/contracts";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useMobileTheme } from "../../../theme/mobile-theme-provider";
import {
  conversationKindLabel,
  conversationListKindLabel,
  relativeTimestamp,
} from "../domain/conversation-view-model";
import { ConversationIdentityAvatar } from "./ConversationIdentityAvatar";

export function ConversationListRow({ conversation, onPress }: {
  readonly conversation: RemoteConversationSummaryV1;
  readonly onPress: () => void;
}) {
  const { theme } = useMobileTheme();
  const unread = conversation.unreadCount > 99 ? "99+" : String(conversation.unreadCount);
  const accessibilityLabel = [
    conversationKindLabel(conversation.kind),
    conversation.title,
    conversation.latestPreview,
    relativeTimestamp(conversation.latestMessageAt ?? conversation.updatedAt),
    conversation.unreadCount > 0 ? `${unread} 条未读` : undefined,
  ].filter(Boolean).join("，");
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, { borderBottomColor: theme.border.hairline }, pressed && { backgroundColor: theme.background.pressed }]}
    >
      <ConversationIdentityAvatar conversation={conversation} />
      <View style={styles.body}>
        <View style={styles.titleLine}>
          <Text numberOfLines={1} style={[styles.title, { color: theme.text.strong }]}>{conversation.title}</Text>
          <Text numberOfLines={1} style={[styles.kind, { color: theme.text.muted }]}>{conversationListKindLabel(conversation)}</Text>
        </View>
        <Text numberOfLines={1} style={[styles.preview, { color: theme.text.muted }]}>{conversation.latestPreview || "还没有消息"}</Text>
      </View>
      <View style={styles.meta}>
        <Text style={[styles.time, { color: theme.text.soft }]}>{relativeTimestamp(conversation.latestMessageAt ?? conversation.updatedAt)}</Text>
        {conversation.unreadCount > 0 ? (
          <View style={[styles.badge, { backgroundColor: theme.action.accent }]}>
            <Text style={[styles.badgeText, { color: theme.action.foreground }]}>{unread}</Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: 82, flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 16, borderBottomWidth: 1 },
  body: { flex: 1, minWidth: 0 },
  titleLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { flexShrink: 1, fontSize: 16, lineHeight: 20, fontWeight: "600" },
  kind: { flexShrink: 0, maxWidth: "48%", fontSize: 11, lineHeight: 15, fontWeight: "600" },
  preview: { marginTop: 5, fontSize: 14, lineHeight: 18 },
  meta: { alignSelf: "stretch", alignItems: "flex-end", justifyContent: "space-between", paddingVertical: 2 },
  time: { fontSize: 11, lineHeight: 15, fontVariant: ["tabular-nums"] },
  badge: { minWidth: 20, height: 20, paddingHorizontal: 6, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  badgeText: { fontSize: 11, fontWeight: "700" },
});
