import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  canonicalJsonDigest,
  compareUtf8Keys,
  parseJsonBytesRejectDuplicateKeys,
  parseJsonRejectDuplicateKeys,
} from "../src/canonical-json.js";
import { iterationDigest } from "../src/iteration.js";
import { pulseDigest, stablePulseJson } from "../src/pulse.js";

describe("canonical JSON trust format", () => {
  it("freezes mixed-case and Unicode map keys in Go-compatible UTF-8 byte order", () => {
    const value = { "😀": 6, "ä": 4, a: 2, "あ": 5, "Á": 3, Z: 1 };
    const golden = "{\"Z\":1,\"a\":2,\"Á\":3,\"ä\":4,\"あ\":5,\"😀\":6}";
    const goldenDigest = "0f1fe24d4557ef543b80ef7d10e460dbcecdc0e4dac7955287950337bc4f0853";

    expect(Object.keys(value).sort(compareUtf8Keys)).toEqual(["Z", "a", "Á", "ä", "あ", "😀"]);
    expect(canonicalJson(value)).toBe(golden);
    expect(canonicalJsonDigest(value)).toBe(goldenDigest);
    expect(stablePulseJson(value)).toBe(golden);
    expect(pulseDigest(value)).toBe(goldenDigest);
    expect(iterationDigest(value)).toBe(goldenDigest);
  });

  it("rejects duplicate decoded keys, including escape-equivalent names", () => {
    expect(() => parseJsonRejectDuplicateKeys('{"state":"ready","state":"accepted"}', "Factfile")).toThrow(/duplicate object key "state"/);
    expect(() => parseJsonRejectDuplicateKeys('{"a":1,"\\u0061":2}', "Factfile")).toThrow(/duplicate object key "a"/);
    expect(parseJsonRejectDuplicateKeys('{"nested":{"Z":1,"ä":2}}')).toEqual({ nested: { Z: 1, "ä": 2 } });
  });

  it("freezes JSON number and literal separator boundaries", () => {
    expect(canonicalJson({ value: -0 })).toBe('{"value":0}');
    expect(canonicalJson({ value: 1e6 })).toBe('{"value":1000000}');
    expect(canonicalJson({ value: 1e-6 })).toBe('{"value":0.000001}');
    expect(canonicalJson({ value: 1e-7 })).toBe('{"value":1e-7}');
    expect(canonicalJson({ value: 1e21 })).toBe('{"value":1e+21}');
    expect(canonicalJson({ value: "line\u2028paragraph\u2029end" })).toBe('{"value":"line\u2028paragraph\u2029end"}');
    expect(canonicalJson({ value: "«redacted»" })).toBe('{"value":"«redacted»"}');
  });

  it("rejects invalid UTF-8 and escaped surrogate forms", () => {
    expect(() => parseJsonBytesRejectDuplicateKeys(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]))).toThrow(/invalid UTF-8/);
    expect(() => parseJsonBytesRejectDuplicateKeys(Buffer.from('{"value":"\\ud800"}'))).toThrow(/surrogate forms/);
    expect(() => parseJsonBytesRejectDuplicateKeys(Buffer.from('{"value":"\\ud83d\\ude00"}'))).toThrow(/surrogate forms/);
    expect(parseJsonBytesRejectDuplicateKeys(Buffer.from('{"value":"😀"}'))).toEqual({ value: "😀" });
  });
});
