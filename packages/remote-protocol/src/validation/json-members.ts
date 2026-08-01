import { RemoteProtocolError } from "../errors.js";

const MAX_JSON_DEPTH = 64;

class JsonMemberScanner {
  private index = 0;

  constructor(private readonly input: string) {}

  scan(): void {
    this.skipWhitespace();
    this.scanValue(0);
    this.skipWhitespace();
    if (this.index !== this.input.length) {
      this.fail("JSON contains trailing data");
    }
  }

  private scanValue(depth: number): void {
    if (depth > MAX_JSON_DEPTH) {
      this.fail("JSON nesting exceeds the protocol limit");
    }
    const character = this.input[this.index];
    if (character === "{") {
      this.scanObject(depth + 1);
    } else if (character === "[") {
      this.scanArray(depth + 1);
    } else if (character === "\"") {
      this.scanString();
    } else if (character === "t") {
      this.scanLiteral("true");
    } else if (character === "f") {
      this.scanLiteral("false");
    } else if (character === "n") {
      this.scanLiteral("null");
    } else {
      this.scanNumber();
    }
  }

  private scanObject(depth: number): void {
    this.index += 1;
    this.skipWhitespace();
    if (this.input[this.index] === "}") {
      this.index += 1;
      return;
    }
    const members = new Set<string>();
    while (this.index < this.input.length) {
      if (this.input[this.index] !== "\"") {
        this.fail("JSON object member must be a string");
      }
      const member = this.scanString();
      if (members.has(member)) {
        throw new RemoteProtocolError("invalid_json", "JSON object contains a duplicate member name");
      }
      members.add(member);
      this.skipWhitespace();
      if (this.input[this.index] !== ":") {
        this.fail("JSON object member is missing a colon");
      }
      this.index += 1;
      this.skipWhitespace();
      this.scanValue(depth);
      this.skipWhitespace();
      if (this.input[this.index] === "}") {
        this.index += 1;
        return;
      }
      if (this.input[this.index] !== ",") {
        this.fail("JSON object is missing a comma");
      }
      this.index += 1;
      this.skipWhitespace();
    }
    this.fail("JSON object is not terminated");
  }

  private scanArray(depth: number): void {
    this.index += 1;
    this.skipWhitespace();
    if (this.input[this.index] === "]") {
      this.index += 1;
      return;
    }
    while (this.index < this.input.length) {
      this.scanValue(depth);
      this.skipWhitespace();
      if (this.input[this.index] === "]") {
        this.index += 1;
        return;
      }
      if (this.input[this.index] !== ",") {
        this.fail("JSON array is missing a comma");
      }
      this.index += 1;
      this.skipWhitespace();
    }
    this.fail("JSON array is not terminated");
  }

  private scanString(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.input.length) {
      const code = this.input.charCodeAt(this.index);
      if (code === 0x22) {
        this.index += 1;
        try {
          return JSON.parse(this.input.slice(start, this.index)) as string;
        } catch {
          this.fail("JSON string is invalid");
        }
      }
      if (code < 0x20) {
        this.fail("JSON string contains a control character");
      }
      if (code === 0x5c) {
        this.index += 1;
        const escape = this.input[this.index];
        if (escape === "u") {
          const hex = this.input.slice(this.index + 1, this.index + 5);
          if (!/^[0-9A-Fa-f]{4}$/.test(hex)) {
            this.fail("JSON unicode escape is invalid");
          }
          this.index += 5;
          continue;
        }
        if (!"\"\\/bfnrt".includes(escape ?? "")) {
          this.fail("JSON escape is invalid");
        }
      }
      this.index += 1;
    }
    this.fail("JSON string is not terminated");
  }

  private scanLiteral(literal: string): void {
    if (this.input.slice(this.index, this.index + literal.length) !== literal) {
      this.fail("JSON literal is invalid");
    }
    this.index += literal.length;
  }

  private scanNumber(): void {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.input.slice(this.index));
    if (!match) {
      this.fail("JSON value is invalid");
    }
    this.index += match[0].length;
  }

  private skipWhitespace(): void {
    while (this.index < this.input.length && /[\u0009\u000a\u000d\u0020]/.test(this.input[this.index])) {
      this.index += 1;
    }
  }

  private fail(message: string): never {
    throw new RemoteProtocolError("invalid_json", message);
  }
}

/** Reject duplicate JSON object names before JSON.parse can overwrite them. */
export function assertNoDuplicateJsonMembers(input: string): void {
  new JsonMemberScanner(input).scan();
}
