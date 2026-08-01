import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import Ionicons from "@expo/vector-icons/Ionicons";
import * as ImagePicker from "expo-image-picker";
import { useEffect, useMemo, useState } from "react";
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { MobileStackParamList } from "../../navigation/types";
import { useMobileRemote } from "../../remote/MobileRemoteProvider";
import { useMobileTheme } from "../../theme/mobile-theme-provider";
import { initials } from "../conversations/domain/conversation-view-model";

type Props = NativeStackScreenProps<MobileStackParamList, "My">;

export function MyScreen({ navigation }: Props) {
  const { theme, preference, setPreference } = useMobileTheme();
  const { client, remoteState, unpair } = useMobileRemote();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const profile = remoteState.profile;
  const [displayName, setDisplayName] = useState(profile?.displayName ?? "");
  const [avatarDataUrl, setAvatarDataUrl] = useState<string | undefined>(profile?.avatarDataUrl);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!editing) {
      setDisplayName(profile?.displayName ?? "");
      setAvatarDataUrl(profile?.avatarDataUrl);
    }
  }, [profile?.displayName, profile?.avatarDataUrl, editing]);

  const chooseAvatar = async (): Promise<void> => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError("需要照片权限才能选择头像。 ");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      base64: true,
      quality: 0.3,
    });
    const asset = result.canceled ? undefined : result.assets[0];
    if (!asset?.base64) return;
    if (Math.floor(asset.base64.length * 0.75) > 72 * 1024) {
      setError("这张照片处理后仍然太大，请选择更小的图片。 ");
      return;
    }
    const mimeType = asset.mimeType === "image/png" || asset.mimeType === "image/webp" ? asset.mimeType : "image/jpeg";
    setAvatarDataUrl(`data:${mimeType};base64,${asset.base64}`);
  };

  const save = async (): Promise<void> => {
    if (!client || !displayName.trim() || [...displayName.trim()].length > 80) {
      setError("名称需要包含 1–80 个字符。 ");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const handle = await client.updateProfile({ displayName: displayName.trim(), ...(avatarDataUrl !== profile?.avatarDataUrl ? { avatarDataUrl: avatarDataUrl ?? null } : {}) });
      await handle.completion;
      setEditing(false);
    } catch {
      setError("个人资料保存失败，请检查 PC 连接。 ");
    } finally {
      setSaving(false);
    }
  };

  const confirmUnpair = (): void => {
    Alert.alert(
      "取消绑定这台 PC？",
      "这会删除本机设备密钥和缓存会话。之后需要重新扫描 PC 配对码。",
      [
        { text: "保留绑定", style: "cancel" },
        { text: "取消绑定", style: "destructive", onPress: () => void unpair() },
      ],
    );
  };

  return (
    <SafeAreaView edges={["top", "bottom"]} style={styles.screen}>
      <View style={styles.header}>
        <Pressable accessibilityLabel="返回会话" accessibilityRole="button" hitSlop={8} onPress={() => navigation.goBack()} style={styles.back}>
          <Ionicons color={theme.text.strong} name="chevron-back" size={25} />
        </Pressable>
        <Text accessibilityRole="header" style={styles.headerTitle}>我的</Text>
        <View style={styles.headerSpacer} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.profileCard}>
          <Pressable accessibilityLabel={editing ? "选择新头像" : "个人头像"} accessibilityRole={editing ? "button" : "image"} disabled={!editing} onPress={() => void chooseAvatar()} style={styles.avatarButton}>
            {avatarDataUrl ? <Image source={{ uri: avatarDataUrl }} style={styles.avatar} /> : <View style={styles.avatarFallback}><Text style={styles.avatarText}>{initials(displayName || "我")}</Text></View>}
            {editing ? <View style={styles.avatarEdit}><Text style={styles.avatarEditText}>更换</Text></View> : null}
          </Pressable>
          <View style={styles.profileCopy}>
            {editing ? (
              <TextInput accessibilityLabel="显示名称" autoFocus maxLength={80} onChangeText={setDisplayName} style={styles.nameInput} value={displayName} />
            ) : <Text numberOfLines={1} style={styles.name}>{profile?.displayName ?? "本地用户"}</Text>}
            <Text numberOfLines={1} style={styles.handle}>@{profile?.handle ?? "local-user"}</Text>
            {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
            {editing ? (
              <View style={styles.editActions}><TextButton label="取消" onPress={() => setEditing(false)} /><PrimarySmallButton disabled={saving} label={saving ? "保存中…" : "保存"} onPress={() => void save()} /></View>
            ) : null}
          </View>
          {!editing ? (
            <Pressable accessibilityRole="button" onPress={() => setEditing(true)} style={({ pressed }) => [styles.editProfile, pressed && { backgroundColor: theme.background.pressed }]}>
              <Text style={styles.editProfileText}>编辑</Text>
            </Pressable>
          ) : null}
        </View>

        <Section title="界面偏好">
          <View style={styles.settingsRow}>
            <View style={styles.settingsCopy}>
              <Text style={styles.settingsLabel}>跟随系统</Text>
              <Text style={styles.settingsHint}>自动使用 Ling Light 或 Ling Dark</Text>
            </View>
            <Pressable
              accessibilityLabel="跟随系统主题"
              accessibilityRole="switch"
              accessibilityState={{ checked: preference === "system" }}
              onPress={() => void setPreference(preference === "system" ? theme.mode : "system")}
              style={({ pressed }) => [
                styles.togglePill,
                { backgroundColor: preference === "system" ? theme.action.accent : theme.border.strong },
                pressed && { opacity: 0.82 },
              ]}
            >
              <View
                style={[
                  styles.toggleKnob,
                  { backgroundColor: theme.action.foreground, transform: [{ translateX: preference === "system" ? 17 : 0 }] },
                ]}
              />
            </Pressable>
          </View>
          <Pressable
            accessibilityLabel={`主题，Ling ${theme.mode === "light" ? "Light" : "Dark"}`}
            accessibilityRole="button"
            onPress={() => void setPreference(theme.mode === "light" ? "dark" : "light")}
            style={({ pressed }) => [styles.settingsRow, styles.settingsRowBorder, pressed && { backgroundColor: theme.background.pressed }]}
          >
            <View style={styles.settingsCopy}>
              <Text style={styles.settingsLabel}>主题</Text>
              <Text style={styles.settingsHint}>仅影响当前手机</Text>
            </View>
            <View style={styles.settingsValueWrap}>
              <Text style={styles.settingsValue}>Ling {theme.mode === "light" ? "Light" : "Dark"}</Text>
              <Ionicons color={theme.text.muted} name="chevron-forward" size={15} />
            </View>
          </Pressable>
        </Section>

        <Section title="已绑定的 PC">
          <View style={styles.settingsRow}>
            <View style={styles.settingsCopy}>
              <Text numberOfLines={1} style={styles.settingsLabel}>{remoteState.workspace?.displayName ?? "Ling PC"}</Text>
              <Text numberOfLines={1} style={styles.settingsHint}>上次同步：{remoteState.connection === "connected" ? "刚刚" : "等待重新连接"}</Text>
            </View>
            <View style={styles.pcStatus}>
              <View style={[styles.pcStatusDot, { backgroundColor: remoteState.connection === "connected" ? theme.status.success : theme.status.warning }]} />
              <Text style={[styles.pcStatusText, { color: theme.text.muted }]}>{remoteState.connection === "connected" ? "已连接" : "离线"}</Text>
            </View>
          </View>
        </Section>

        <Pressable accessibilityRole="button" onPress={confirmUnpair} style={styles.unpair}><Text style={styles.unpairText}>取消绑定</Text></Pressable>
      </ScrollView>
    </SafeAreaView>
  );

  function Section({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
    return <View style={styles.section}><Text style={styles.sectionTitle}>{title}</Text>{children}</View>;
  }

  function TextButton({ label, onPress }: { readonly label: string; readonly onPress: () => void }) {
    return <Pressable accessibilityRole="button" onPress={onPress} style={styles.textButton}><Text style={styles.textButtonLabel}>{label}</Text></Pressable>;
  }

  function PrimarySmallButton({ label, onPress, disabled }: { readonly label: string; readonly onPress: () => void; readonly disabled: boolean }) {
    return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={styles.primarySmall}><Text style={styles.primarySmallText}>{label}</Text></Pressable>;
  }
}

function createStyles(theme: ReturnType<typeof useMobileTheme>["theme"]) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.background.app },
    header: { minHeight: 66, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, backgroundColor: theme.background.panel, borderBottomWidth: 1, borderBottomColor: theme.border.hairline },
    back: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
    headerTitle: { color: theme.text.strong, fontSize: 17, fontWeight: "600" },
    headerSpacer: { width: 44 },
    content: { paddingHorizontal: 16, paddingTop: 20, paddingBottom: 32 },
    profileCard: { minHeight: 98, flexDirection: "row", alignItems: "center", gap: 14, padding: 18, borderRadius: 16, backgroundColor: theme.background.panel },
    avatarButton: { width: 62, height: 62, borderRadius: 31, overflow: "hidden" },
    avatar: { width: 62, height: 62, borderRadius: 31 },
    avatarFallback: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: theme.identity.background },
    avatarText: { color: theme.identity.foreground, fontSize: 20, fontWeight: "700" },
    avatarEdit: { position: "absolute", left: 0, right: 0, bottom: 0, height: 24, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.58)" },
    avatarEditText: { color: "#fff", fontSize: 11, fontWeight: "700" },
    profileCopy: { flex: 1, minWidth: 0 },
    name: { color: theme.text.strong, fontSize: 18, lineHeight: 23, fontWeight: "700" },
    handle: { marginTop: 3, color: theme.text.muted, fontSize: 13, lineHeight: 17 },
    nameInput: { minHeight: 36, borderRadius: 9, borderWidth: 1, borderColor: theme.border.default, backgroundColor: theme.background.panel, color: theme.text.strong, fontSize: 16, paddingHorizontal: 10, paddingVertical: 6 },
    error: { marginTop: 4, color: theme.status.danger, fontSize: 11, lineHeight: 15 },
    editActions: { marginTop: 8, flexDirection: "row", alignItems: "center", gap: 8 },
    editProfile: { minHeight: 36, justifyContent: "center", paddingHorizontal: 12, borderWidth: 1, borderColor: theme.border.default, borderRadius: 9, backgroundColor: theme.background.panel },
    editProfileText: { color: theme.text.strong, fontSize: 12, fontWeight: "600" },
    textButton: { minHeight: 36, justifyContent: "center", paddingHorizontal: 10 },
    textButtonLabel: { color: theme.text.strong, fontSize: 12, fontWeight: "600" },
    primarySmall: { minHeight: 36, borderRadius: 9, justifyContent: "center", backgroundColor: theme.action.accent, paddingHorizontal: 14 },
    primarySmallText: { color: theme.action.foreground, fontSize: 12, fontWeight: "700" },
    section: { marginTop: 18, overflow: "hidden", borderRadius: 16, backgroundColor: theme.background.panel },
    sectionTitle: { color: theme.text.muted, fontSize: 12, lineHeight: 16, fontWeight: "600", paddingHorizontal: 16, paddingTop: 15, paddingBottom: 8 },
    settingsRow: { minHeight: 54, paddingHorizontal: 16, paddingVertical: 10, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, backgroundColor: theme.background.panel },
    settingsRowBorder: { borderTopWidth: 1, borderTopColor: theme.border.hairline },
    settingsCopy: { flex: 1, minWidth: 0 },
    settingsLabel: { color: theme.text.strong, fontSize: 15, lineHeight: 20, fontWeight: "600" },
    settingsHint: { marginTop: 2, color: theme.text.muted, fontSize: 11, lineHeight: 15 },
    settingsValueWrap: { flexDirection: "row", alignItems: "center", gap: 4 },
    settingsValue: { color: theme.text.muted, fontSize: 13 },
    togglePill: { width: 45, height: 28, borderRadius: 999, padding: 3 },
    toggleKnob: { width: 22, height: 22, borderRadius: 11 },
    pcStatus: { flexDirection: "row", alignItems: "center", gap: 6 },
    pcStatusDot: { width: 7, height: 7, borderRadius: 999 },
    pcStatusText: { fontSize: 12 },
    unpair: { minHeight: 44, alignItems: "center", justifyContent: "center", marginTop: 22 },
    unpairText: { color: theme.status.danger, fontSize: 14, fontWeight: "600" },
  });
}
