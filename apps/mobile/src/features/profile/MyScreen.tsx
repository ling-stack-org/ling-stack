import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as ImagePicker from "expo-image-picker";
import { useEffect, useMemo, useState } from "react";
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { MobileStackParamList } from "../../navigation/types";
import { useMobileRemote } from "../../remote/MobileRemoteProvider";
import { useMobileTheme } from "../../theme/mobile-theme-provider";
import type { MobileThemePreference } from "../../theme/mobile-theme";
import { initials } from "../conversations/domain/conversation-view-model";

type Props = NativeStackScreenProps<MobileStackParamList, "My">;

export function MyScreen({ navigation }: Props) {
  const { theme, preference, setPreference } = useMobileTheme();
  const { binding, client, remoteState, unpair } = useMobileRemote();
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
        <Pressable accessibilityLabel="返回会话" accessibilityRole="button" hitSlop={8} onPress={() => navigation.goBack()} style={styles.back}><Text style={styles.backText}>‹</Text></Pressable>
        <Text accessibilityRole="header" style={styles.headerTitle}>我的</Text>
        <View style={styles.headerSpacer} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.profileSection}>
          <Pressable accessibilityLabel={editing ? "选择新头像" : "个人头像"} accessibilityRole={editing ? "button" : "image"} disabled={!editing} onPress={() => void chooseAvatar()} style={styles.avatarButton}>
            {avatarDataUrl ? <Image source={{ uri: avatarDataUrl }} style={styles.avatar} /> : <View style={styles.avatarFallback}><Text style={styles.avatarText}>{initials(displayName || "我")}</Text></View>}
            {editing ? <View style={styles.avatarEdit}><Text style={styles.avatarEditText}>更换</Text></View> : null}
          </Pressable>
          {editing ? (
            <TextInput accessibilityLabel="显示名称" autoFocus maxLength={80} onChangeText={setDisplayName} style={styles.nameInput} value={displayName} />
          ) : <Text style={styles.name}>{profile?.displayName ?? "本地用户"}</Text>}
          <Text style={styles.handle}>@{profile?.handle ?? "local-user"}</Text>
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          {editing ? (
            <View style={styles.editActions}><TextButton label="取消" onPress={() => setEditing(false)} /><PrimarySmallButton disabled={saving} label={saving ? "保存中…" : "保存"} onPress={() => void save()} /></View>
          ) : <TextButton label="编辑个人资料" onPress={() => setEditing(true)} />}
        </View>

        <Section title="界面偏好">
          {(["system", "light", "dark"] as const).map((option) => (
            <PreferenceRow key={option} label={themeLabel(option)} selected={preference === option} onPress={() => void setPreference(option)} />
          ))}
        </Section>

        <Section title="已绑定的 PC">
          <View style={styles.pcRow}>
            <View style={styles.pcIcon}><Text style={styles.pcIconText}>PC</Text></View>
            <View style={styles.pcText}><Text numberOfLines={1} style={styles.pcTitle}>{remoteState.workspace?.displayName ?? "Ling PC"}</Text><Text numberOfLines={1} style={styles.pcSubtitle}>{binding?.gatewayId ?? "安全连接"}</Text></View>
            <Text style={[styles.pcStatus, { color: remoteState.connection === "connected" ? theme.status.success : theme.status.warning }]}>{remoteState.connection === "connected" ? "已连接" : "离线"}</Text>
          </View>
        </Section>

        <Pressable accessibilityRole="button" onPress={confirmUnpair} style={styles.unpair}><Text style={styles.unpairText}>取消绑定</Text></Pressable>
      </ScrollView>
    </SafeAreaView>
  );

  function Section({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
    return <View style={styles.section}><Text style={styles.sectionTitle}>{title}</Text><View style={styles.sectionBody}>{children}</View></View>;
  }

  function PreferenceRow({ label, selected, onPress }: { readonly label: string; readonly selected: boolean; readonly onPress: () => void }) {
    return <Pressable accessibilityRole="radio" accessibilityState={{ checked: selected }} onPress={onPress} style={({ pressed }) => [styles.preferenceRow, pressed && { backgroundColor: theme.background.pressed }]}><Text style={styles.preferenceLabel}>{label}</Text><View style={[styles.radio, selected && styles.radioSelected]}>{selected ? <View style={styles.radioDot} /> : null}</View></Pressable>;
  }

  function TextButton({ label, onPress }: { readonly label: string; readonly onPress: () => void }) {
    return <Pressable accessibilityRole="button" onPress={onPress} style={styles.textButton}><Text style={styles.textButtonLabel}>{label}</Text></Pressable>;
  }

  function PrimarySmallButton({ label, onPress, disabled }: { readonly label: string; readonly onPress: () => void; readonly disabled: boolean }) {
    return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={styles.primarySmall}><Text style={styles.primarySmallText}>{label}</Text></Pressable>;
  }
}

function themeLabel(preference: MobileThemePreference): string {
  return preference === "system" ? "跟随系统" : preference === "light" ? "Ling Light" : "Ling Dark";
}

function createStyles(theme: ReturnType<typeof useMobileTheme>["theme"]) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.background.app },
    header: { height: 54, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 10, backgroundColor: theme.background.panel, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border.default },
    back: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
    backText: { color: theme.text.strong, fontSize: 38, lineHeight: 40, fontWeight: "300", marginTop: -3 },
    headerTitle: { color: theme.text.strong, fontSize: 17, fontWeight: "600" },
    headerSpacer: { width: 44 },
    content: { paddingBottom: 32 },
    profileSection: { alignItems: "center", gap: 8, paddingHorizontal: 20, paddingVertical: 28, backgroundColor: theme.background.panel },
    avatarButton: { width: 86, height: 86, borderRadius: 28, overflow: "hidden", marginBottom: 4 },
    avatar: { width: 86, height: 86 },
    avatarFallback: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: theme.background.subtle },
    avatarText: { color: theme.text.strong, fontSize: 27, fontWeight: "700" },
    avatarEdit: { position: "absolute", left: 0, right: 0, bottom: 0, height: 24, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.58)" },
    avatarEditText: { color: "#fff", fontSize: 11, fontWeight: "700" },
    name: { color: theme.text.strong, fontSize: 20, lineHeight: 26, fontWeight: "700" },
    handle: { color: theme.text.muted, fontSize: 13 },
    nameInput: { width: "80%", minHeight: 44, borderRadius: 10, backgroundColor: theme.background.subtle, color: theme.text.strong, fontSize: 17, textAlign: "center", paddingHorizontal: 12 },
    error: { color: theme.status.danger, fontSize: 13, lineHeight: 18, textAlign: "center" },
    editActions: { flexDirection: "row", alignItems: "center", gap: 8 },
    textButton: { minHeight: 44, justifyContent: "center", paddingHorizontal: 14 },
    textButtonLabel: { color: theme.text.strong, fontSize: 14, fontWeight: "600" },
    primarySmall: { minHeight: 40, borderRadius: 10, justifyContent: "center", backgroundColor: theme.action.accent, paddingHorizontal: 18 },
    primarySmallText: { color: theme.text.inverse, fontSize: 14, fontWeight: "700" },
    section: { marginTop: 20, gap: 7 },
    sectionTitle: { color: theme.text.muted, fontSize: 12, fontWeight: "600", paddingHorizontal: 20, textTransform: "uppercase" },
    sectionBody: { backgroundColor: theme.background.panel, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.border.default },
    preferenceRow: { minHeight: 52, paddingHorizontal: 20, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border.default },
    preferenceLabel: { color: theme.text.default, fontSize: 16 },
    radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: theme.border.default, alignItems: "center", justifyContent: "center" },
    radioSelected: { borderColor: theme.action.accent },
    radioDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: theme.action.accent },
    pcRow: { minHeight: 68, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 20, paddingVertical: 10 },
    pcIcon: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: theme.background.subtle },
    pcIconText: { color: theme.text.strong, fontSize: 11, fontWeight: "700" },
    pcText: { flex: 1, minWidth: 0 },
    pcTitle: { color: theme.text.strong, fontSize: 15, fontWeight: "600" },
    pcSubtitle: { color: theme.text.muted, fontSize: 11, lineHeight: 16 },
    pcStatus: { fontSize: 12, fontWeight: "600" },
    unpair: { minHeight: 52, alignItems: "center", justifyContent: "center", marginTop: 28, marginHorizontal: 20, borderRadius: 12, backgroundColor: theme.background.panel },
    unpairText: { color: theme.status.danger, fontSize: 15, fontWeight: "600" },
  });
}
