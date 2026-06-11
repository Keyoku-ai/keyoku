import jmespath from "jmespath";

import type { Assertion, AssertionResult, ProbeEnvelope } from "./types.js";

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) {
    // Tolerate "1" vs 1 mismatches coming from text probes / JSON values.
    const na = asNumber(a);
    const nb = asNumber(b);
    if (na !== null && nb !== null) return na === nb;
    return false;
  }
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function lengthOf(v: unknown): number | null {
  if (typeof v === "string" || Array.isArray(v)) return v.length;
  if (v !== null && typeof v === "object") return Object.keys(v).length;
  return null;
}

function compareNumeric(
  actual: unknown,
  expected: unknown,
  cmp: (a: number, b: number) => boolean,
): AssertionResult {
  const a = asNumber(actual);
  const b = asNumber(expected);
  if (a === null || b === null) {
    return {
      pass: false,
      actual,
      error: `numeric comparison needs numbers, got ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`,
    };
  }
  return { pass: cmp(a, b), actual };
}

function elementwise(
  actual: unknown,
  expected: unknown,
  mode: "all" | "any",
  test: (el: unknown, expected: unknown) => boolean,
): AssertionResult {
  if (!Array.isArray(actual)) {
    return {
      pass: false,
      actual,
      error: `${mode}_* ops need an array, got ${typeof actual}`,
    };
  }
  // Vacuous truth: all_* over an empty array passes ("all zero services
  // comply"); any_* over an empty array fails. JMESPath projections silently
  // drop entries missing the projected key, so a vacuous pass often means the
  // path matched nothing — flag it so the caller can pair it with a length
  // guard instead of trusting it blindly.
  const pass =
    mode === "all"
      ? actual.every((el) => test(el, expected))
      : actual.some((el) => test(el, expected));
  if (pass && mode === "all" && actual.length === 0) {
    return {
      pass,
      actual,
      note: "vacuously true: the path matched an empty array — pair with a len_* guard if entries might be silently dropped",
    };
  }
  return { pass, actual };
}

const numericTest =
  (cmp: (a: number, b: number) => boolean) =>
  (el: unknown, expected: unknown): boolean => {
    const a = asNumber(el);
    const b = asNumber(expected);
    return a !== null && b !== null && cmp(a, b);
  };

/**
 * Evaluate one assertion against a probe envelope. Never throws — mechanical
 * problems (bad path, type mismatch, invalid regex) come back as a failing
 * result with an `error` explaining why.
 */
export function evaluateAssertion(
  envelope: ProbeEnvelope,
  assertion: Assertion,
): AssertionResult {
  let actual: unknown;
  try {
    actual = assertion.path
      ? jmespath.search(envelope, assertion.path)
      : envelope.output;
  } catch (err) {
    return {
      pass: false,
      actual: undefined,
      error: `JMESPath error for '${assertion.path}': ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const { op, value } = assertion;
  switch (op) {
    case "eq":
      return { pass: deepEqual(actual, value), actual };
    case "ne":
      return { pass: !deepEqual(actual, value), actual };
    case "gt":
      return compareNumeric(actual, value, (a, b) => a > b);
    case "gte":
      return compareNumeric(actual, value, (a, b) => a >= b);
    case "lt":
      return compareNumeric(actual, value, (a, b) => a < b);
    case "lte":
      return compareNumeric(actual, value, (a, b) => a <= b);
    case "contains":
    case "not_contains": {
      let contains: boolean;
      if (typeof actual === "string") {
        contains = actual.includes(String(value));
      } else if (Array.isArray(actual)) {
        contains = actual.some((el) => deepEqual(el, value));
      } else {
        return {
          pass: false,
          actual,
          error: `contains needs a string or array, got ${actual === null ? "null" : typeof actual}`,
        };
      }
      return { pass: op === "contains" ? contains : !contains, actual };
    }
    case "matches": {
      if (typeof actual !== "string") {
        return {
          pass: false,
          actual,
          error: `matches needs a string, got ${actual === null ? "null" : typeof actual}`,
        };
      }
      try {
        return { pass: new RegExp(String(value)).test(actual), actual };
      } catch (err) {
        return {
          pass: false,
          actual,
          error: `invalid regex ${JSON.stringify(value)}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    case "exists":
      return { pass: actual !== null && actual !== undefined, actual };
    case "not_exists":
      return { pass: actual === null || actual === undefined, actual };
    case "truthy":
      return { pass: Boolean(actual), actual };
    case "falsy":
      return { pass: !actual, actual };
    case "len_eq":
    case "len_gte":
    case "len_lte": {
      const len = lengthOf(actual);
      if (len === null) {
        return {
          pass: false,
          actual,
          error: `len_* ops need a string, array, or object, got ${actual === null ? "null" : typeof actual}`,
        };
      }
      const expected = asNumber(value);
      if (expected === null) {
        return { pass: false, actual, error: `len_* ops need a numeric value` };
      }
      const pass =
        op === "len_eq"
          ? len === expected
          : op === "len_gte"
            ? len >= expected
            : len <= expected;
      return { pass, actual };
    }
    case "all_eq":
      return elementwise(actual, value, "all", deepEqual);
    case "all_gte":
      return elementwise(actual, value, "all", numericTest((a, b) => a >= b));
    case "all_lte":
      return elementwise(actual, value, "all", numericTest((a, b) => a <= b));
    case "any_eq":
      return elementwise(actual, value, "any", deepEqual);
    case "any_gte":
      return elementwise(actual, value, "any", numericTest((a, b) => a >= b));
    case "any_lte":
      return elementwise(actual, value, "any", numericTest((a, b) => a <= b));
    default: {
      const exhausted: never = op;
      return { pass: false, actual, error: `unknown op ${String(exhausted)}` };
    }
  }
}
