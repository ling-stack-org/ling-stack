import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { useMobileTheme } from "../../../theme/mobile-theme-provider";

export function PlainTextComposer({ value, onChange, onSend, connected, sending, placeholder = "发消息…" }: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSend: () => void;
  readonly connected: boolean;
  readonly sending: boolean;
  readonly placeholder?: string;
}) {
  const { theme } = useMobileTheme();
  const enabled = connected && value.trim().length > 0 && !sending;
  return (
    <View style={[styles.shell, { backgroundColor: theme.background.composer, borderTopColor: theme.border.hairline }]}>
      <View style={[styles.inputShell, { backgroundColor: theme.background.panel, borderColor: theme.border.default }]}>
        <TextInput
          accessibilityLabel="消息"
          editable
          maxLength={16_000}
          multiline
          onChangeText={onChange}
          placeholder={connected ? placeholder : "连接 PC 后发送"}
          placeholderTextColor={theme.text.muted}
          style={[styles.input, { color: theme.text.default }]}
          value={value}
        />
        <Pressable
          accessibilityLabel="发送消息"
          accessibilityRole="button"
          accessibilityState={{ disabled: !enabled }}
          disabled={!enabled}
          onPress={onSend}
          style={[styles.send, { backgroundColor: theme.action.accent, opacity: enabled ? 1 : 0.94 }]}
        >
          <Text style={[styles.sendText, { color: theme.action.foreground }]}>发送</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: { borderTopWidth: 1, paddingHorizontal: 10, paddingTop: 8, paddingBottom: 4 },
  inputShell: { minHeight: 50, maxHeight: 106, borderWidth: 1, borderRadius: 16, flexDirection: "row", alignItems: "flex-end", gap: 8, paddingLeft: 14, paddingRight: 5, paddingVertical: 5 },
  input: { flex: 1, minHeight: 38, maxHeight: 96, fontSize: 16, lineHeight: 22, paddingTop: 8, paddingBottom: 8 },
  send: { width: 44, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  sendText: { fontSize: 15, fontWeight: "700" },
});
