import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  canonicalJsonDigest,
  compareUtf8Keys,
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
});
