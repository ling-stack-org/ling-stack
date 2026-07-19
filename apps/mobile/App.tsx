import { useState } from "react";
import { Button, SafeAreaView, ScrollView, StyleSheet, Text, View } from "react-native";

import { runSecureDeviceKeyFixture } from "./src/platform/secure-device-key/fixture-runner";

type SpikeState =
  | { readonly status: "idle" }
  | { readonly status: "running" }
  | { readonly status: "passed"; readonly detail: string }
  | { readonly status: "failed"; readonly detail: string };

export default function App() {
  const [state, setState] = useState<SpikeState>({ status: "idle" });

  const runSpike = async () => {
    setState({ status: "running" });
    try {
      const result = await runSecureDeviceKeyFixture();
      setState({
        status: "passed",
        detail: JSON.stringify(result, null, 2),
      });
    } catch (error) {
      setState({
        status: "failed",
        detail: error instanceof Error ? error.message : "secure_key_spike_failed",
      });
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Ling Secure Device Key Spike</Text>
        <Text style={styles.description}>
          生成不可导出的 P-256 设备密钥，执行共享协议 fixture，并验证签名与篡改拒绝。
        </Text>
        <Button
          title={state.status === "running" ? "验证中…" : "运行硬件密钥验证"}
          disabled={state.status === "running"}
          onPress={() => void runSpike()}
        />
        {state.status !== "idle" && state.status !== "running" ? (
          <View style={styles.result}>
            <Text style={state.status === "passed" ? styles.passed : styles.failed}>
              {state.status === "passed" ? "PASS" : "FAIL"}
            </Text>
            <Text selectable style={styles.detail}>{state.detail}</Text>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#f5f5f7" },
  container: { flexGrow: 1, justifyContent: "center", gap: 20, padding: 24 },
  title: { color: "#111", fontSize: 24, fontWeight: "700" },
  description: { color: "#444", fontSize: 16, lineHeight: 24 },
  result: { gap: 12, borderRadius: 12, backgroundColor: "#fff", padding: 16 },
  passed: { color: "#147d32", fontSize: 18, fontWeight: "700" },
  failed: { color: "#b42318", fontSize: 18, fontWeight: "700" },
  detail: { color: "#222", fontFamily: "monospace", fontSize: 12 },
});
