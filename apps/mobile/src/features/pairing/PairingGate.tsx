import Ionicons from "@expo/vector-icons/Ionicons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useMobileRemote } from "../../remote/MobileRemoteProvider";
import { useMobileTheme } from "../../theme/mobile-theme-provider";

export function PairingGate() {
  const remote = useMobileRemote();
  if (remote.phase === "scanner") {
    return <PairingScannerScreen />;
  }
  if (remote.phase === "submitting" || remote.phase === "awaiting_pc" || remote.phase === "initial_sync" || remote.phase === "loading") {
    return <PairingProgressScreen />;
  }
  return <PairingWelcomeScreen />;
}

function PairingWelcomeScreen() {
  const { theme } = useMobileTheme();
  const remote = useMobileRemote();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.welcomeContent}>
        <View accessible accessibilityLabel="Ling" style={styles.logo}>
          <Text style={styles.logoText}>L</Text>
        </View>
        <Text accessibilityRole="header" style={styles.welcomeTitle}>连接你的 Ling</Text>
        <Text style={styles.welcomeDescription}>扫描 PC 上的配对码，安全同步已有频道、会话和队友私聊。</Text>
        {remote.error ? <Text accessibilityRole="alert" style={styles.error}>{remote.error}</Text> : null}
        <PrimaryButton label="扫描 PC 配对码" onPress={remote.openScanner} scanIcon />
        <View style={styles.pairingPath}>
          <Text style={styles.pairingPathTitle}>在 PC 上开始：</Text>
          <Text style={styles.pairingPathBody}>设置 → 移动端访问 → 开始配对</Text>
        </View>
        <Text style={styles.securityBody}>一台 PC 仅绑定一部手机。设备私钥不会离开手机，绑定还需要在 PC 上确认。</Text>
      </View>
    </SafeAreaView>
  );
}

function PairingScannerScreen() {
  const { theme } = useMobileTheme();
  const remote = useMobileRemote();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);

  if (!permission) {
    return <LoadingScreen label="正在准备相机…" />;
  }
  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.permissionContent}>
          <Text style={styles.title}>允许使用相机</Text>
          <Text style={styles.description}>Ling 只用相机读取 PC 上的安全配对码，不会保存画面。</Text>
          <PrimaryButton
            label={permission.canAskAgain ? "继续" : "打开系统设置"}
            onPress={() => permission.canAskAgain ? void requestPermission() : void Linking.openSettings()}
          />
          <TextButton label="取消" onPress={remote.cancelPairing} />
        </View>
      </SafeAreaView>
    );
  }
  return (
    <View style={styles.cameraScreen}>
      <CameraView
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={scanned ? undefined : ({ data }) => {
          setScanned(true);
          void remote.pairFromQr(data);
        }}
        style={StyleSheet.absoluteFill}
      />
      <SafeAreaView style={styles.cameraOverlay}>
        <View style={styles.cameraHeader}>
          <Pressable accessibilityRole="button" hitSlop={12} onPress={remote.cancelPairing} style={styles.cameraCancel}>
            <Text style={styles.cameraCancelText}>取消</Text>
          </Pressable>
          <Text style={styles.cameraTitle}>扫描 PC 配对码</Text>
          <View style={styles.cameraHeaderSpacer} />
        </View>
        <View accessible accessibilityLabel="将二维码放入取景框" style={styles.scanFrame} />
        <Text style={styles.cameraHint}>将 PC 上的二维码完整放入框内</Text>
      </SafeAreaView>
    </View>
  );
}

function PairingProgressScreen() {
  const { theme } = useMobileTheme();
  const remote = useMobileRemote();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [seconds, setSeconds] = useState(() => remainingSeconds(remote.pendingPairing?.qr.expiresAt));
  useEffect(() => {
    const timer = setInterval(() => setSeconds(remainingSeconds(remote.pendingPairing?.qr.expiresAt)), 1_000);
    return () => clearInterval(timer);
  }, [remote.pendingPairing?.qr.expiresAt]);
  const awaiting = remote.phase === "awaiting_pc";
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.progressContent}>
        <View style={styles.progressRing}><ActivityIndicator color={theme.action.accent} size="large" /></View>
        <Text accessibilityRole="header" style={styles.title}>
          {awaiting ? "请在 PC 上确认" : remote.phase === "initial_sync" ? "正在同步 PC 会话…" : "正在验证安全连接…"}
        </Text>
        <Text style={styles.description}>
          {awaiting ? "确认“我的 iPhone”后，这里会自动进入会话。" : "正在确认 Gateway 身份和设备密钥。"}
        </Text>
        {awaiting && seconds !== undefined ? <Text style={styles.countdown}>配对码将在 {formatCountdown(seconds)} 后过期</Text> : null}
        {remote.pendingPairing ? (
          <View style={styles.fingerprintBox}>
            <Text style={styles.fingerprintLabel}>安全指纹</Text>
            <Text selectable style={styles.fingerprintValue}>{shortFingerprint(remote.pendingPairing.qr.gatewayIdentityFingerprint)}</Text>
          </View>
        ) : null}
        {remote.phase !== "initial_sync" ? <TextButton label="取消配对" onPress={remote.cancelPairing} /> : null}
      </View>
    </SafeAreaView>
  );
}

function LoadingScreen({ label }: { readonly label: string }) {
  const { theme } = useMobileTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return <SafeAreaView style={styles.screen}><View style={styles.progressContent}><ActivityIndicator color={theme.action.accent} /><Text style={styles.description}>{label}</Text></View></SafeAreaView>;
}

function PrimaryButton({ label, onPress, scanIcon = false }: {
  readonly label: string;
  readonly onPress: () => void;
  readonly scanIcon?: boolean;
}) {
  const { theme } = useMobileTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.primaryButton, pressed && { opacity: 0.82 }]}>
      {scanIcon ? <Ionicons color={theme.action.foreground} name="scan-outline" size={18} /> : null}
      <Text style={styles.primaryButtonText}>{label}</Text>
    </Pressable>
  );
}

function TextButton({ label, onPress }: { readonly label: string; readonly onPress: () => void }) {
  const { theme } = useMobileTheme();
  return <Pressable accessibilityRole="button" hitSlop={10} onPress={onPress} style={shared.textButton}><Text style={[shared.textButtonText, { color: theme.text.default }]}>{label}</Text></Pressable>;
}

function remainingSeconds(expiresAt?: string): number | undefined {
  return expiresAt ? Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1_000)) : undefined;
}

function formatCountdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function shortFingerprint(value: string): string {
  return `${value.slice(0, 6).toUpperCase()} · ${value.slice(-6).toUpperCase()}`;
}

function createStyles(theme: ReturnType<typeof useMobileTheme>["theme"]) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.background.panel, paddingHorizontal: 28 },
    welcomeContent: { flex: 1, alignItems: "center", paddingTop: 118, paddingBottom: 28 },
    logo: { width: 68, height: 68, borderRadius: 21, alignItems: "center", justifyContent: "center", backgroundColor: theme.action.accent },
    logoText: { color: theme.action.foreground, fontSize: 28, fontWeight: "700" },
    welcomeTitle: { marginTop: 30, color: theme.text.strong, fontSize: 28, lineHeight: 34, fontWeight: "700", letterSpacing: -0.4, textAlign: "center" },
    welcomeDescription: { maxWidth: 290, marginTop: 8, color: theme.text.muted, fontSize: 15, lineHeight: 22, textAlign: "center" },
    title: { color: theme.text.strong, fontSize: 28, lineHeight: 34, fontWeight: "700", textAlign: "center" },
    description: { color: theme.text.muted, fontSize: 16, lineHeight: 24, textAlign: "center" },
    error: { marginTop: 12, color: theme.status.danger, fontSize: 13, lineHeight: 18, textAlign: "center" },
    primaryButton: { width: "100%", minHeight: 52, marginTop: 42, paddingHorizontal: 24, borderRadius: 14, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 9, backgroundColor: theme.action.accent },
    primaryButtonText: { color: theme.action.foreground, fontSize: 16, fontWeight: "700" },
    pairingPath: { width: "100%", marginTop: 34, paddingHorizontal: 14, paddingVertical: 13, borderWidth: 1, borderColor: theme.border.default, borderRadius: 12, backgroundColor: theme.background.subtle },
    pairingPathTitle: { color: theme.text.default, fontSize: 12, lineHeight: 18, fontWeight: "700" },
    pairingPathBody: { color: theme.text.default, fontSize: 12, lineHeight: 18 },
    securityBody: { maxWidth: 320, marginTop: "auto", color: theme.text.soft, fontSize: 11, lineHeight: 17, textAlign: "center" },
    permissionContent: { flex: 1, alignItems: "center", justifyContent: "center", gap: 20 },
    cameraScreen: { flex: 1, backgroundColor: "#000" },
    cameraOverlay: { flex: 1, alignItems: "center", justifyContent: "space-between", paddingHorizontal: 24, paddingBottom: 64 },
    cameraHeader: { width: "100%", height: 52, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    cameraCancel: { minWidth: 52, minHeight: 44, justifyContent: "center" },
    cameraCancelText: { color: "#fff", fontSize: 16 },
    cameraTitle: { color: "#fff", fontSize: 17, fontWeight: "600" },
    cameraHeaderSpacer: { width: 52 },
    scanFrame: { width: 260, height: 260, borderRadius: 24, borderWidth: 3, borderColor: "rgba(255,255,255,0.9)" },
    cameraHint: { color: "#fff", fontSize: 15, textAlign: "center", backgroundColor: "rgba(0,0,0,0.45)", paddingHorizontal: 16, paddingVertical: 10, borderRadius: 999 },
    progressContent: { flex: 1, alignItems: "center", justifyContent: "center", gap: 20 },
    progressRing: { width: 72, height: 72, borderRadius: 36, backgroundColor: theme.background.subtle, alignItems: "center", justifyContent: "center" },
    countdown: { color: theme.status.info, fontSize: 14, fontWeight: "600" },
    fingerprintBox: { borderRadius: 10, backgroundColor: theme.background.subtle, paddingHorizontal: 20, paddingVertical: 12, alignItems: "center", gap: 4 },
    fingerprintLabel: { color: theme.text.muted, fontSize: 12 },
    fingerprintValue: { color: theme.text.strong, fontSize: 15, fontVariant: ["tabular-nums"], letterSpacing: 1 },
  });
}

const shared = StyleSheet.create({
  textButton: { minHeight: 44, minWidth: 80, alignItems: "center", justifyContent: "center", paddingHorizontal: 12 },
  textButtonText: { fontSize: 15, fontWeight: "600" },
});
