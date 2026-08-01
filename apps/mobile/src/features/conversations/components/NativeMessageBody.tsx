import type { MessageBodyBlock, MessageInlineToken } from "@ling-stack/conversation-ui-core";
import type { ReactNode } from "react";
import { Linking, Platform, ScrollView, StyleSheet, Text, View } from "react-native";

import type { MobileThemeTokens } from "../../../theme/mobile-theme";
import { useMobileTheme } from "../../../theme/mobile-theme-provider";

export function NativeMessageBody({
  blocks,
  emptyFallback,
}: {
  readonly blocks: readonly MessageBodyBlock[];
  readonly emptyFallback?: string;
}) {
  const { theme } = useMobileTheme();
  if (blocks.length === 0) {
    return emptyFallback ? <Text style={[styles.paragraph, { color: theme.text.muted }]}>{emptyFallback}</Text> : null;
  }
  return (
    <View style={styles.root}>
      {blocks.map((block, index) => renderBlock(block, `${block.kind}:${index}`, theme))}
    </View>
  );
}

function renderBlock(block: MessageBodyBlock, key: string, theme: MobileThemeTokens): ReactNode {
  switch (block.kind) {
    case "paragraph":
      return <Text key={key} selectable style={[styles.paragraph, { color: theme.text.default }]}>{renderInlineTokens(block.inlines, theme)}</Text>;
    case "heading":
      return (
        <Text
          key={key}
          selectable
          accessibilityRole="header"
          style={[styles.heading, headingStyle(block.depth), { color: theme.text.strong }]}
        >
          {renderInlineTokens(block.inlines, theme)}
        </Text>
      );
    case "quote":
      return (
        <View key={key} style={[styles.quote, { borderLeftColor: theme.border.strong, backgroundColor: theme.background.subtle }]}>
          {block.blocks.map((child, index) => renderBlock(child, `${key}:${child.kind}:${index}`, theme))}
        </View>
      );
    case "list":
      return (
        <View key={key} style={styles.list}>
          {block.items.map((item, index) => (
            <View key={`${key}:item:${index}`} style={styles.listItem}>
              <Text style={[styles.listMarker, { color: theme.text.muted }]}>
                {listMarker(block.ordered, block.start, index, item.checked)}
              </Text>
              <View style={styles.listContent}>
                {item.blocks.map((child, childIndex) => renderBlock(child, `${key}:item:${index}:${child.kind}:${childIndex}`, theme))}
              </View>
            </View>
          ))}
        </View>
      );
    case "code":
      return renderCodeBlock(key, block.code, block.language, block.complete, theme);
    case "mermaid":
      return renderCodeBlock(key, block.source, "mermaid · 暂不渲染图表", block.complete, theme);
    case "math":
      return renderCodeBlock(key, block.source, "math · 暂不渲染公式", block.complete, theme);
    case "table":
      return (
        <ScrollView
          key={key}
          horizontal
          nestedScrollEnabled
          showsHorizontalScrollIndicator
          style={[styles.tableFrame, { borderColor: theme.border.default }]}
        >
          <View>
            {block.rows.map((row, rowIndex) => (
              <View key={`${key}:row:${rowIndex}`} style={[styles.tableRow, rowIndex > 0 && { borderTopColor: theme.border.hairline, borderTopWidth: StyleSheet.hairlineWidth }]}>
                {row.map((cell, cellIndex) => (
                  <Text
                    key={`${key}:row:${rowIndex}:cell:${cellIndex}`}
                    selectable
                    style={[
                      styles.tableCell,
                      rowIndex === 0 && styles.tableHeading,
                      { color: rowIndex === 0 ? theme.text.strong : theme.text.default, textAlign: block.align[cellIndex] ?? "left" },
                    ]}
                  >
                    {renderInlineTokens(cell, theme)}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      );
    case "thematic_break":
      return <View key={key} style={[styles.thematicBreak, { backgroundColor: theme.border.hairline }]} />;
  }
}

function renderCodeBlock(
  key: string,
  code: string,
  language: string | undefined,
  complete: boolean,
  theme: MobileThemeTokens,
): ReactNode {
  return (
    <View key={key} style={[styles.codeFrame, { borderColor: theme.border.default, backgroundColor: theme.background.subtle }]}>
      {language || !complete ? (
        <Text style={[styles.codeLabel, { color: theme.text.muted }]}>
          {language || "text"}{complete ? "" : " · 正在生成"}
        </Text>
      ) : null}
      <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
        <Text selectable style={[styles.code, { color: theme.text.default }]}>{code}</Text>
      </ScrollView>
    </View>
  );
}

function renderInlineTokens(tokens: readonly MessageInlineToken[], theme: MobileThemeTokens): ReactNode[] {
  return tokens.map((token, index) => {
    const key = `${token.kind}:${index}`;
    switch (token.kind) {
      case "text":
        return token.text;
      case "line_break":
        return "\n";
      case "mention":
        return <Text key={key} style={[styles.mention, { color: theme.status.info, backgroundColor: theme.status.infoBackground }]}>{token.text}</Text>;
      case "strong":
        return <Text key={key} style={styles.strong}>{renderInlineTokens(token.children, theme)}</Text>;
      case "emphasis":
        return <Text key={key} style={styles.emphasis}>{renderInlineTokens(token.children, theme)}</Text>;
      case "delete":
        return <Text key={key} style={styles.deleted}>{renderInlineTokens(token.children, theme)}</Text>;
      case "inline_code":
        return <Text key={key} style={[styles.inlineCode, { color: theme.text.strong, backgroundColor: theme.background.subtle }]}>{token.code}</Text>;
      case "inline_math":
        return <Text key={key} style={[styles.inlineCode, { color: theme.text.default, backgroundColor: theme.background.subtle }]}>{`$${token.source}$`}</Text>;
      case "web_link":
        return (
          <Text
            key={key}
            accessibilityRole="link"
            suppressHighlighting={false}
            style={[styles.link, { color: theme.status.info }]}
            onPress={() => void openWebLink(token.href)}
          >
            {token.label}
          </Text>
        );
      case "local_file":
        return (
          <Text key={key} style={[styles.inlineCode, { color: theme.text.muted, backgroundColor: theme.background.subtle }]}>
            {token.reference.displayPath}
          </Text>
        );
    }
  });
}

async function openWebLink(href: string): Promise<void> {
  if (!/^https?:\/\//iu.test(href)) return;
  await Linking.openURL(href).catch(() => undefined);
}

function headingStyle(depth: 1 | 2 | 3 | 4 | 5 | 6) {
  if (depth === 1) return styles.heading1;
  if (depth === 2) return styles.heading2;
  if (depth === 3) return styles.heading3;
  return styles.headingSmall;
}

function listMarker(ordered: boolean, start: number | undefined, index: number, checked: boolean | undefined): string {
  if (checked !== undefined) return checked ? "☑" : "☐";
  if (ordered) return `${(start ?? 1) + index}.`;
  return "•";
}

const styles = StyleSheet.create({
  root: { maxWidth: "100%", gap: 9 },
  paragraph: { fontSize: 16, lineHeight: 24 },
  heading: { fontWeight: "700" },
  heading1: { fontSize: 23, lineHeight: 30 },
  heading2: { fontSize: 20, lineHeight: 27 },
  heading3: { fontSize: 18, lineHeight: 25 },
  headingSmall: { fontSize: 16, lineHeight: 24 },
  quote: { gap: 7, borderLeftWidth: 3, borderRadius: 6, paddingHorizontal: 11, paddingVertical: 8 },
  list: { gap: 5 },
  listItem: { flexDirection: "row", alignItems: "flex-start" },
  listMarker: { width: 28, paddingTop: 1, fontSize: 15, lineHeight: 23, textAlign: "right" },
  listContent: { flex: 1, gap: 5, paddingLeft: 8 },
  codeFrame: { overflow: "hidden", borderWidth: 1, borderRadius: 10 },
  codeLabel: { paddingHorizontal: 11, paddingTop: 7, paddingBottom: 3, fontSize: 11, lineHeight: 15, fontWeight: "600" },
  code: {
    paddingHorizontal: 11,
    paddingVertical: 9,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
    fontSize: 13,
    lineHeight: 20,
  },
  tableFrame: { borderWidth: 1, borderRadius: 8 },
  tableRow: { flexDirection: "row" },
  tableCell: { minWidth: 112, maxWidth: 220, paddingHorizontal: 9, paddingVertical: 7, fontSize: 13, lineHeight: 19 },
  tableHeading: { fontWeight: "700" },
  thematicBreak: { height: StyleSheet.hairlineWidth, marginVertical: 4 },
  mention: { fontWeight: "700" },
  strong: { fontWeight: "700" },
  emphasis: { fontStyle: "italic" },
  deleted: { textDecorationLine: "line-through" },
  inlineCode: {
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
    fontSize: 14,
  },
  link: { textDecorationLine: "underline", fontWeight: "600" },
});
