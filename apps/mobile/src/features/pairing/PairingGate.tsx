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
        <View style={styles.centerText}>
          <Text accessibilityRole="header" style={styles.title}>连接你的 Ling</Text>
          <Text style={styles.description}>扫描 PC 上的配对码，安全同步已有会话。</Text>
        </View>
        {remote.error ? <Text accessibilityRole="alert" style={styles.error}>{remote.error}</Text> : null}
        <PrimaryButton label="扫描 PC 配对码" onPress={remote.openScanner} />
        <Text style={styles.instruction}>在 PC：设置 → 设备 → 移动端访问 → 开始配对</Text>
      </View>
      <View style={styles.securityNote}>
        <Text style={styles.securityTitle}>设备级安全连接</Text>
        <Text style={styles.securityBody}>一台 PC 仅绑定一部手机。私钥不会离开当前设备，绑定还需要在 PC 上确认。</Text>
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

function PrimaryButton({ label, onPress }: { readonly label: string; readonly onPress: () => void }) {
  const { theme } = useMobileTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.primaryButton, pressed && { opacity: 0.82 }]}>
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
    screen: { flex: 1, backgroundColor: theme.background.app, paddingHorizontal: 24 },
    welcomeContent: { flex: 1, alignItems: "center", justifyContent: "center", gap: 24 },
    logo: { width: 72, height: 72, borderRadius: 24, alignItems: "center", justifyContent: "center", backgroundColor: theme.action.accent },
    logoText: { color: theme.text.inverse, fontSize: 36, fontWeight: "700" },
    centerText: { alignItems: "center", gap: 8 },
    title: { color: theme.text.strong, fontSize: 28, lineHeight: 34, fontWeight: "700", textAlign: "center" },
    description: { color: theme.text.muted, fontSize: 16, lineHeight: 24, textAlign: "center" },
    instruction: { color: theme.text.muted, fontSize: 13, lineHeight: 19, textAlign: "center" },
    error: { color: theme.status.danger, fontSize: 14, lineHeight: 20, textAlign: "center" },
    primaryButton: { minHeight: 52, minWidth: 220, paddingHorizontal: 24, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: theme.action.accent },
    primaryButtonText: { color: theme.text.inverse, fontSize: 16, fontWeight: "600" },
    securityNote: { marginBottom: 20, borderRadius: 14, backgroundColor: theme.background.subtle, padding: 16, gap: 4 },
    securityTitle: { color: theme.text.strong, fontSize: 13, fontWeight: "600" },
    securityBody: { color: theme.text.muted, fontSize: 13, lineHeight: 19 },
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
