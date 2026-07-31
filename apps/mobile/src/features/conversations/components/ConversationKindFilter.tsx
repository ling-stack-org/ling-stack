import { Pressable, StyleSheet, Text, View } from "react-native";

import { useMobileTheme } from "../../../theme/mobile-theme-provider";
import type { ConversationFilter } from "../domain/conversation-view-model";

const options: readonly { readonly value: ConversationFilter; readonly label: string }[] = [
  { value: "all", label: "全部" },
  { value: "channel", label: "频道" },
  { value: "conversation", label: "会话" },
  { value: "teammate_direct", label: "私聊" },
];

export function ConversationKindFilter({ value, onChange }: {
  readonly value: ConversationFilter;
  readonly onChange: (value: ConversationFilter) => void;
}) {
  const { theme } = useMobileTheme();
  return (
    <View accessibilityRole="tablist" style={[styles.container, { backgroundColor: theme.background.subtle }]}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            key={option.value}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => [
              styles.option,
              selected && { backgroundColor: theme.action.accent },
              pressed && !selected && { backgroundColor: theme.background.pressed },
            ]}
          >
            <Text style={[styles.label, { color: selected ? theme.text.inverse : theme.text.muted }]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flexDirection: "row", borderRadius: 10, padding: 3, gap: 2 },
  option: { flex: 1, minHeight: 38, alignItems: "center", justifyContent: "center", borderRadius: 8 },
  label: { fontSize: 14, fontWeight: "600" },
});
