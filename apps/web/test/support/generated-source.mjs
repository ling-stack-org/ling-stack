const SCRIPT_UNSAFE_CHARACTERS = /[<>/\u2028\u2029]/gu;
const SCRIPT_ESCAPES = Object.freeze({
  "<": "\\u003C",
  ">": "\\u003E",
  "/": "\\u002F",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
});

/**
 * Serializes a value for insertion into generated JavaScript source.
 * JSON string escaping protects the JavaScript literal; the additional escapes
 * keep a literal from terminating an enclosing HTML script element.
 */
export function jsonStringLiteralForGeneratedSource(value) {
  return JSON.stringify(value).replace(SCRIPT_UNSAFE_CHARACTERS, character => SCRIPT_ESCAPES[character]);
}
