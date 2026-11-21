export interface ProtectedMessage {
  text: string;
  tokens: string[];
}

export interface ProtectedMessagePart {
  kind: "text" | "token";
  value: string;
}

export declare const protectedMarkerPattern: RegExp;
export declare function protectMessage(value: string): ProtectedMessage;
export declare function restoreProtectedTokens(value: string, tokens: readonly string[]): string;
export declare function protectedMessageParts(value: string, tokens: readonly string[]): ProtectedMessagePart[];
export declare function splitTranslatableText(value: string): {
  left: string;
  separator: string;
  right: string;
} | undefined;
