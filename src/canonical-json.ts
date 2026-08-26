import { createHash } from "node:crypto";

/** Go encoding/json-compatible map-key order: lexicographic UTF-8 bytes. */
export function compareUtf8Keys(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function encodeCanonical(value: unknown, arrayItem: boolean): string | undefined {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return arrayItem ? "null" : undefined;
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value === "bigint") throw new Error("Canonical JSON cannot encode bigint values.");
  if (Array.isArray(value)) return `[${value.map((item) => encodeCanonical(item, true) ?? "null").join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => encodeCanonical(item, false) !== undefined)
      .sort(([left], [right]) => compareUtf8Keys(left, right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${encodeCanonical(item, false)}`).join(",")}}`;
  }
  throw new Error(`Canonical JSON cannot encode ${typeof value}.`);
}

export function canonicalJson(value: unknown): string {
  const encoded = encodeCanonical(value, false);
  if (encoded === undefined) throw new Error("Canonical JSON root cannot be undefined.");
  return encoded;
}

export function canonicalJsonDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function bytesDigest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function decodeUtf8Strict(value: Uint8Array, label = "UTF-8 input"): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(value); }
  catch { throw new Error(`${label}: invalid UTF-8 byte sequence.`); }
}

/** Strict JSON parser that rejects duplicate decoded object keys. */
export function parseJsonRejectDuplicateKeys(text: string, label = "JSON"): unknown {
  let cursor = 0;
  const fail = (message: string): never => { throw new Error(`${label}: ${message} at byte ${Buffer.byteLength(text.slice(0, cursor), "utf8")}.`); };
  const whitespace = () => { while (cursor < text.length && /[\u0020\u000a\u000d\u0009]/.test(text[cursor]!)) cursor += 1; };
  const string = (): string => {
    if (text[cursor] !== '"') fail("expected string");
    const start = cursor;
    cursor += 1;
    while (cursor < text.length) {
      const character = text[cursor]!;
      if (character === '"') {
        cursor += 1;
        const token = text.slice(start, cursor);
        if (/\\u[dD][89a-fA-F][0-9a-fA-F]{2}/u.test(token)) fail("escaped UTF-16 surrogate forms are not permitted");
        let decoded: string;
        try { decoded = JSON.parse(token) as string; }
        catch { return fail("invalid string escape"); }
        for (let index = 0; index < decoded.length; index += 1) {
          const code = decoded.charCodeAt(index);
          if (code >= 0xd800 && code <= 0xdbff) {
            const low = decoded.charCodeAt(index + 1);
            if (low < 0xdc00 || low > 0xdfff) fail("unpaired UTF-16 surrogate is not permitted");
            index += 1;
          } else if (code >= 0xdc00 && code <= 0xdfff) fail("unpaired UTF-16 surrogate is not permitted");
        }
        return decoded;
      }
      if (character === "\\") {
        cursor += 2;
        continue;
      }
      if (character.charCodeAt(0) < 0x20) fail("unescaped control character");
      cursor += 1;
    }
    return fail("unterminated string");
  };
  const value = (): unknown => {
    whitespace();
    const character = text[cursor];
    if (character === '"') return string();
    if (character === "{") {
      cursor += 1;
      whitespace();
      const object = Object.create(null) as Record<string, unknown>;
      const keys = new Set<string>();
      if (text[cursor] === "}") { cursor += 1; return object; }
      for (;;) {
        whitespace();
        const key = string();
        if (keys.has(key)) fail(`duplicate object key ${JSON.stringify(key)}`);
        keys.add(key);
        whitespace();
        if (text[cursor] !== ":") fail("expected ':' after object key");
        cursor += 1;
        object[key] = value();
        whitespace();
        if (text[cursor] === "}") { cursor += 1; return object; }
        if (text[cursor] !== ",") fail("expected ',' or '}'");
        cursor += 1;
      }
    }
    if (character === "[") {
      cursor += 1;
      whitespace();
      const array: unknown[] = [];
      if (text[cursor] === "]") { cursor += 1; return array; }
      for (;;) {
        array.push(value());
        whitespace();
        if (text[cursor] === "]") { cursor += 1; return array; }
        if (text[cursor] !== ",") fail("expected ',' or ']'");
        cursor += 1;
      }
    }
    const rest = text.slice(cursor);
    if (rest.startsWith("true")) { cursor += 4; return true; }
    if (rest.startsWith("false")) { cursor += 5; return false; }
    if (rest.startsWith("null")) { cursor += 4; return null; }
    const number = rest.match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u)?.[0];
    if (number) {
      cursor += number.length;
      const parsed = Number(number);
      if (!Number.isFinite(parsed)) fail("number is outside the finite JSON range");
      return parsed;
    }
    fail("expected JSON value");
  };
  const parsed = value();
  whitespace();
  if (cursor !== text.length) fail("unexpected trailing content");
  return parsed;
}

export function parseJsonBytesRejectDuplicateKeys(value: Uint8Array, label = "JSON"): unknown {
  return parseJsonRejectDuplicateKeys(decodeUtf8Strict(value, label), label);
}
