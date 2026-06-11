import { describe, expect, it } from "vitest";

import { evaluateAssertion } from "../src/assert.js";
import type { ProbeEnvelope } from "../src/types.js";

const env = (output: unknown, extra: Partial<ProbeEnvelope> = {}): ProbeEnvelope => ({
  output,
  ...extra,
});

describe("evaluateAssertion", () => {
  it("defaults path to output", () => {
    expect(evaluateAssertion(env(42), { op: "eq", value: 42 }).pass).toBe(true);
    expect(evaluateAssertion(env(42), { op: "eq", value: 41 }).pass).toBe(false);
  });

  it("eq deep-compares objects and arrays", () => {
    expect(
      evaluateAssertion(env({ a: [1, { b: 2 }] }), { op: "eq", value: { a: [1, { b: 2 }] } }).pass,
    ).toBe(true);
    expect(
      evaluateAssertion(env({ a: 1, b: 2 }), { op: "eq", value: { a: 1 } }).pass,
    ).toBe(false);
  });

  it("eq tolerates numeric strings", () => {
    expect(evaluateAssertion(env("5"), { op: "eq", value: 5 }).pass).toBe(true);
  });

  it("ne negates eq", () => {
    expect(evaluateAssertion(env("x"), { op: "ne", value: "y" }).pass).toBe(true);
  });

  it("numeric comparisons coerce strings and reject non-numbers", () => {
    expect(evaluateAssertion(env("10"), { op: "gte", value: 5 }).pass).toBe(true);
    expect(evaluateAssertion(env(3), { op: "lt", value: 5 }).pass).toBe(true);
    expect(evaluateAssertion(env(7), { op: "lte", value: 5 }).pass).toBe(false);
    expect(evaluateAssertion(env(7), { op: "gt", value: 5 }).pass).toBe(true);
    const bad = evaluateAssertion(env("abc"), { op: "gte", value: 5 });
    expect(bad.pass).toBe(false);
    expect(bad.error).toContain("numeric");
  });

  it("contains works on strings and arrays", () => {
    expect(evaluateAssertion(env("hello world"), { op: "contains", value: "world" }).pass).toBe(true);
    expect(evaluateAssertion(env([1, 2, 3]), { op: "contains", value: 2 }).pass).toBe(true);
    expect(evaluateAssertion(env([{ a: 1 }]), { op: "contains", value: { a: 1 } }).pass).toBe(true);
    expect(evaluateAssertion(env(42), { op: "contains", value: 4 }).error).toBeTruthy();
    expect(evaluateAssertion(env("hello"), { op: "not_contains", value: "x" }).pass).toBe(true);
  });

  it("matches applies regex and rejects invalid patterns", () => {
    expect(evaluateAssertion(env("v1.2.3"), { op: "matches", value: "^v\\d+" }).pass).toBe(true);
    expect(evaluateAssertion(env("nope"), { op: "matches", value: "^v\\d+" }).pass).toBe(false);
    expect(evaluateAssertion(env("x"), { op: "matches", value: "(" }).error).toContain("invalid regex");
    expect(evaluateAssertion(env(5), { op: "matches", value: "5" }).error).toContain("string");
  });

  it("exists / not_exists / truthy / falsy", () => {
    expect(evaluateAssertion(env({ a: 1 }), { path: "output.a", op: "exists" }).pass).toBe(true);
    expect(evaluateAssertion(env({ a: 1 }), { path: "output.b", op: "exists" }).pass).toBe(false);
    expect(evaluateAssertion(env({ a: 1 }), { path: "output.b", op: "not_exists" }).pass).toBe(true);
    expect(evaluateAssertion(env(""), { op: "falsy" }).pass).toBe(true);
    expect(evaluateAssertion(env("x"), { op: "truthy" }).pass).toBe(true);
  });

  it("len_* on strings, arrays, objects", () => {
    expect(evaluateAssertion(env([1, 2, 3]), { op: "len_eq", value: 3 }).pass).toBe(true);
    expect(evaluateAssertion(env("abcd"), { op: "len_gte", value: 4 }).pass).toBe(true);
    expect(evaluateAssertion(env({ a: 1, b: 2 }), { op: "len_lte", value: 2 }).pass).toBe(true);
    expect(evaluateAssertion(env(5), { op: "len_eq", value: 1 }).error).toBeTruthy();
  });

  it("all_* and any_* are elementwise with vacuous-truth semantics", () => {
    expect(evaluateAssertion(env([2, 3, 4]), { op: "all_gte", value: 2 }).pass).toBe(true);
    expect(evaluateAssertion(env([2, 1]), { op: "all_gte", value: 2 }).pass).toBe(false);
    const vacuous = evaluateAssertion(env([]), { op: "all_gte", value: 2 });
    expect(vacuous.pass).toBe(true);
    expect(vacuous.note).toContain("vacuously");
    expect(evaluateAssertion(env([1]), { op: "all_gte", value: 1 }).note).toBeUndefined();
    expect(evaluateAssertion(env([]), { op: "any_eq", value: 1 }).pass).toBe(false);
    expect(evaluateAssertion(env([1, 5]), { op: "any_gte", value: 5 }).pass).toBe(true);
    expect(evaluateAssertion(env([5, 6]), { op: "all_lte", value: 6 }).pass).toBe(true);
    expect(evaluateAssertion(env(["a", "b"]), { op: "any_eq", value: "b" }).pass).toBe(true);
    expect(evaluateAssertion(env("not-array"), { op: "all_eq", value: 1 }).error).toContain("array");
  });

  it("JMESPath paths reach into envelopes and projections", () => {
    const envelope = env([{ name: "a", min: 1 }, { name: "b", min: 0 }], { exitCode: 0 });
    expect(evaluateAssertion(envelope, { path: "output[*].min", op: "all_gte", value: 1 }).pass).toBe(false);
    expect(evaluateAssertion(envelope, { path: "exitCode", op: "eq", value: 0 }).pass).toBe(true);
    expect(evaluateAssertion(envelope, { path: "output[0].name", op: "eq", value: "a" }).pass).toBe(true);
  });

  it("reports JMESPath syntax errors instead of throwing", () => {
    const result = evaluateAssertion(env({}), { path: "output[", op: "exists" });
    expect(result.pass).toBe(false);
    expect(result.error).toContain("JMESPath");
  });
});
