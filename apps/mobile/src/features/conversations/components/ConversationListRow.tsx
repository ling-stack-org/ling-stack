import type { RemoteConversationSummaryV1 } from "@ling-stack/contracts";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";

import { useMobileTheme } from "../../../theme/mobile-theme-provider";
import {
  conversationGlyph,
  conversationKindLabel,
  conversationSubtitle,
  relativeTimestamp,
} from "../domain/conversation-view-model";

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
      style={({ pressed }) => [styles.row, { borderBottomColor: theme.border.default }, pressed && { backgroundColor: theme.background.pressed }]}
    >
      {conversation.identity.avatarDataUrl ? (
        <Image source={{ uri: conversation.identity.avatarDataUrl }} style={styles.avatar} />
      ) : (
        <View style={[styles.avatar, { backgroundColor: theme.background.subtle }]}>
          <Text style={[styles.avatarText, { color: theme.text.strong }]}>{conversationGlyph(conversation)}</Text>
        </View>
      )}
      <View style={styles.body}>
        <View style={styles.titleLine}>
          <Text numberOfLines={1} style={[styles.title, { color: theme.text.strong }]}>{conversation.title}</Text>
          <Text style={[styles.time, { color: theme.text.muted }]}>{relativeTimestamp(conversation.latestMessageAt ?? conversation.updatedAt)}</Text>
        </View>
        <Text numberOfLines={1} style={[styles.subtitle, { color: theme.text.muted }]}>{conversationSubtitle(conversation)}</Text>
        <View style={styles.previewLine}>
          <Text numberOfLines={1} style={[styles.preview, { color: theme.text.default }]}>{conversation.latestPreview || "还没有消息"}</Text>
          {conversation.unreadCount > 0 ? (
            <View style={[styles.badge, { backgroundColor: theme.action.accent }]}>
              <Text style={[styles.badgeText, { color: theme.text.inverse }]}>{unread}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: 86, flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth },
  avatar: { width: 42, height: 42, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  avatarText: { fontSize: 17, fontWeight: "700" },
  body: { flex: 1, minWidth: 0, gap: 2 },
  titleLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { flex: 1, fontSize: 16, lineHeight: 21, fontWeight: "600" },
  time: { fontSize: 12, lineHeight: 16, fontVariant: ["tabular-nums"] },
  subtitle: { fontSize: 12, lineHeight: 16 },
  previewLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  preview: { flex: 1, fontSize: 14, lineHeight: 19 },
  badge: { minWidth: 22, height: 20, paddingHorizontal: 6, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  badgeText: { fontSize: 11, fontWeight: "700" },
});
