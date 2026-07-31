import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { MobileStackParamList } from "../../../navigation/types";
import { useMobileRemote } from "../../../remote/MobileRemoteProvider";
import { useMobileTheme } from "../../../theme/mobile-theme-provider";
import { ConversationKindFilter } from "../components/ConversationKindFilter";
import { ConversationListRow } from "../components/ConversationListRow";
import { SyncStatusStrip } from "../components/SyncStatusStrip";
import { filterAndSortConversations, initials, type ConversationFilter } from "../domain/conversation-view-model";

type Props = NativeStackScreenProps<MobileStackParamList, "Conversations">;

export function ConversationIndexScreen({ navigation }: Props) {
  const { theme } = useMobileTheme();
  const { remoteState, retryConnection } = useMobileRemote();
  const [filter, setFilter] = useState<ConversationFilter>("all");
  const styles = useMemo(() => createStyles(theme), [theme]);
  const conversations = useMemo(
    () => filterAndSortConversations(Object.values(remoteState.conversations), filter),
    [remoteState.conversations, filter],
  );
  const profileName = remoteState.profile?.displayName ?? "我";
  const loading = conversations.length === 0 && (remoteState.connection === "connecting" || remoteState.connection === "reconnecting");

  return (
    <SafeAreaView edges={["top"]} style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.headerTitle}>
          <View style={styles.titleLine}>
            <Text accessibilityRole="header" style={styles.title}>会话</Text>
            <SyncStatusStrip status={remoteState.connection} />
          </View>
          <Text numberOfLines={1} style={styles.pcName}>{remoteState.workspace?.displayName ?? "Ling PC"}</Text>
        </View>
        <Pressable
          accessibilityLabel="打开我的资料"
          accessibilityRole="button"
          hitSlop={6}
          onPress={() => navigation.navigate("My")}
          style={({ pressed }) => [styles.profileButton, pressed && { opacity: 0.72 }]}
        >
          {remoteState.profile?.avatarDataUrl ? <Image source={{ uri: remoteState.profile.avatarDataUrl }} style={styles.profileImage} /> : <Text style={styles.profileInitials}>{initials(profileName)}</Text>}
        </Pressable>
      </View>
      <View style={styles.filter}><ConversationKindFilter value={filter} onChange={setFilter} /></View>
      {remoteState.connection !== "connected" ? <SyncStatusStrip compact status={remoteState.connection} onRetry={() => void retryConnection()} /> : null}
      {loading ? (
        <View style={styles.loading}><ActivityIndicator color={theme.action.accent} /><Text style={styles.emptyBody}>正在同步 PC 会话…</Text></View>
      ) : (
        <FlatList
          contentContainerStyle={conversations.length === 0 ? styles.emptyList : undefined}
          data={conversations}
          keyExtractor={(item) => item.conversationId}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>{filter === "all" ? "PC 上还没有会话" : `没有${filter === "channel" ? "频道" : filter === "conversation" ? "会话" : "私聊"}`}</Text>
              <Text style={styles.emptyBody}>{filter === "all" ? "在 PC 端开始对话后会出现在这里。" : "切换到全部查看其他会话。"}</Text>
              {filter !== "all" ? <Pressable accessibilityRole="button" onPress={() => setFilter("all")}><Text style={styles.showAll}>查看全部</Text></Pressable> : null}
            </View>
          }
          renderItem={({ item }) => <ConversationListRow conversation={item} onPress={() => navigation.navigate("ConversationDetail", { conversationId: item.conversationId })} />}
          style={styles.list}
        />
      )}
    </SafeAreaView>
  );
}

function createStyles(theme: ReturnType<typeof useMobileTheme>["theme"]) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.background.panel },
    header: { minHeight: 80, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10, flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: theme.background.panel },
    headerTitle: { flex: 1, gap: 1 },
    titleLine: { flexDirection: "row", alignItems: "baseline", gap: 10 },
    title: { color: theme.text.strong, fontSize: 28, lineHeight: 34, fontWeight: "700" },
    pcName: { color: theme.text.muted, fontSize: 13, lineHeight: 18 },
    profileButton: { width: 44, height: 44, borderRadius: 15, alignItems: "center", justifyContent: "center", backgroundColor: theme.background.subtle, overflow: "hidden" },
    profileImage: { width: 44, height: 44 },
    profileInitials: { color: theme.text.strong, fontSize: 15, fontWeight: "700" },
    filter: { paddingHorizontal: 16, paddingBottom: 10 },
    list: { flex: 1 },
    loading: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, backgroundColor: theme.background.panel },
    emptyList: { flexGrow: 1 },
    empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 8 },
    emptyTitle: { color: theme.text.strong, fontSize: 18, fontWeight: "600", textAlign: "center" },
    emptyBody: { color: theme.text.muted, fontSize: 14, lineHeight: 21, textAlign: "center" },
    showAll: { color: theme.text.strong, fontSize: 14, fontWeight: "700", padding: 12 },
  });
}
