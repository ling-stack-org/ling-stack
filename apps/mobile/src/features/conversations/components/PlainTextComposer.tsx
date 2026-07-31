import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { useMobileTheme } from "../../../theme/mobile-theme-provider";

export function PlainTextComposer({ value, onChange, onSend, connected, sending }: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSend: () => void;
  readonly connected: boolean;
  readonly sending: boolean;
}) {
  const { theme } = useMobileTheme();
  const enabled = connected && value.trim().length > 0 && !sending;
  return (
    <View style={[styles.shell, { backgroundColor: theme.background.panel, borderTopColor: theme.border.default }]}>
      <View style={[styles.inputShell, { backgroundColor: theme.background.subtle }]}>
        <TextInput
          accessibilityLabel="消息"
          editable
          maxLength={16_000}
          multiline
          onChangeText={onChange}
          placeholder={connected ? "发消息…" : "连接 PC 后发送"}
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
          style={[styles.send, { backgroundColor: enabled ? theme.action.accent : theme.background.pressed }]}
        >
          <Text style={[styles.sendText, { color: enabled ? theme.text.inverse : theme.text.muted }]}>发送</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8 },
  inputShell: { minHeight: 48, maxHeight: 136, borderRadius: 14, flexDirection: "row", alignItems: "flex-end", paddingLeft: 13, paddingRight: 4, paddingVertical: 4 },
  input: { flex: 1, minHeight: 40, maxHeight: 120, fontSize: 16, lineHeight: 23, paddingTop: 9, paddingBottom: 8 },
  send: { minWidth: 52, minHeight: 44, borderRadius: 11, alignItems: "center", justifyContent: "center", paddingHorizontal: 10 },
  sendText: { fontSize: 14, fontWeight: "700" },
});
