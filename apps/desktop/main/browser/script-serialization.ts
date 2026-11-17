const BROWSER_SCRIPT_LITERAL_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  "<": "\\u003C",
  ">": "\\u003E",
  "/": "\\u002F",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
});

/** Produces a JSON-backed literal safe to embed in generated page JavaScript. */
export function serializeBrowserScriptArgument(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("browser_script_argument_unserializable");
  return serialized.replace(/[<>/\u2028\u2029]/gu, character => BROWSER_SCRIPT_LITERAL_ESCAPES[character]!);
}
