import { describe, expect, test } from "bun:test";
import type { ValidateFunction } from "ajv";

import {
  MAX_ARG_DEPTH,
  MAX_EVAL_PATHS,
  MAX_EVAL_WORK,
  MAX_REF_DEPTH,
  MAX_SCHEMA_NODES,
  checkSchema,
  compileSchema,
  validateArguments,
} from "../src/schema.js";

/**
 * Direct unit checks of the schema subset: local references, anyOf/oneOf, the
 * Tier B keywords, recursion refusal, and the static and work bounds. Nothing
 * here starts a host or a server. No test validates an exponential or huge
 * schema: the fan-out and recursive schemas are refused before Ajv runs, and
 * the large-argument case is refused by the work bound before Ajv runs.
 */

function keywordsOf(schema: unknown): string[] {
  return checkSchema(schema).issues.map((issue) => issue.keyword);
}

/** A validate stub that fails the test if anything calls it. */
function neverValidate(): ValidateFunction {
  const stub = (): boolean => {
    throw new Error("validator must not be reached");
  };
  return Object.assign(stub, { errors: null }) as unknown as ValidateFunction;
}

describe("local $ref and definitions", () => {
  test("a local #/$defs reference is accepted and validates the data", () => {
    const schema = {
      type: "object",
      properties: { a: { $ref: "#/$defs/x" } },
      required: ["a"],
      $defs: { x: { type: "string", minLength: 2 } },
    };
    const compiled = compileSchema(schema);
    expect(compiled.check.supported).toBe(true);
    expect(compiled.validate!({ a: "ok" })).toBe(true);
    expect(compiled.validate!({ a: "x" })).toBe(false);
    expect(compiled.validate!({ a: 1 })).toBe(false);
  });

  test("a local #/definitions reference is accepted and validates the data", () => {
    const schema = {
      type: "object",
      properties: { a: { $ref: "#/definitions/x" } },
      definitions: { x: { type: "integer", minimum: 1 } },
    };
    const compiled = compileSchema(schema);
    expect(compiled.check.supported).toBe(true);
    expect(compiled.validate!({ a: 3 })).toBe(true);
    expect(compiled.validate!({ a: 0 })).toBe(false);
    expect(compiled.validate!({ a: "3" })).toBe(false);
  });

  test("annotation keywords beside $ref are accepted", () => {
    const schema = {
      type: "object",
      properties: {
        a: { $ref: "#/$defs/x", title: "A", description: "d", default: "z", examples: ["q"] },
      },
      $defs: { x: { type: "string" } },
    };
    const check = checkSchema(schema);
    expect(check).toMatchObject({ supported: true, issues: [] });
    expect(check.bound).toBe(2);
  });

  test("a non-annotation keyword beside $ref is rejected under the $ref keyword", () => {
    const schema = {
      type: "object",
      properties: { a: { $ref: "#/$defs/x", type: "string" } },
      $defs: { x: { type: "string" } },
    };
    const check = checkSchema(schema);
    expect(check.supported).toBe(false);
    expect(check.issues).toEqual([{ path: "arguments.properties.a.type", keyword: "$ref" }]);
    expect(compileSchema(schema).validate).toBeUndefined();
  });

  test("a root $ref beside $defs is rejected (the sibling rule applies to the root too)", () => {
    const schema = {
      $defs: { x: { type: "string" } },
      $ref: "#/$defs/x",
    };
    expect(checkSchema(schema).supported).toBe(false);
    expect(keywordsOf(schema)).toContain("$ref");
  });

  test("malformed or non-local reference forms are rejected without reaching Ajv", () => {
    const forms: unknown[] = [
      "#",
      "#/properties/x",
      "#/$defs/a/b",
      "#/$defs/",
      "#/$defs/bad.name",
      "#/$defs/missing",
      "#/definitions/x",
      "other.json#/x",
      "file:///etc/passwd",
      "https://example.invalid/s.json",
      "#/$defs/a/../b",
      5,
      null,
    ];

    let fetches = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetches += 1;
      throw new Error("no I/O is allowed while checking a schema");
    }) as unknown as typeof fetch;
    try {
      for (const ref of forms) {
        const schema = {
          type: "object",
          properties: { a: { $ref: ref } },
          $defs: { a: { type: "string" }, x: { type: "string" } },
        };
        const check = checkSchema(schema);
        expect(check.supported).toBe(false);
        expect(check.issues.map((issue) => issue.keyword)).toContain("$ref");
        const compiled = compileSchema(schema);
        expect(compiled.validate).toBeUndefined();
      }
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(fetches).toBe(0);
  });

  test("$defs and definitions below the root are rejected", () => {
    const nested = { type: "object", properties: { a: { type: "object", $defs: { x: { type: "string" } } } } };
    expect(checkSchema(nested).issues).toEqual([{ path: "arguments.properties.a.$defs", keyword: "$defs" }]);

    const nestedDefinitions = {
      $defs: { x: { type: "string", definitions: { y: { type: "string" } } } },
      type: "object",
    };
    expect(keywordsOf(nestedDefinitions)).toContain("definitions");
  });

  test("a $defs member name outside the allowed pattern is rejected", () => {
    const schema = { $defs: { "bad name": { type: "string" } }, type: "object" };
    expect(checkSchema(schema).issues).toEqual([{ path: "arguments.$defs.bad name", keyword: "$defs" }]);
  });

  test("a definitions member is walked as a schema", () => {
    const schema = { definitions: { x: { type: "string", pattern: "(" } }, type: "object" };
    expect(checkSchema(schema).issues).toEqual([{ path: "arguments.definitions.x.pattern", keyword: "pattern" }]);
  });

  test("a non-recursive DAG with shared definitions is accepted and validates", () => {
    const schema = {
      $defs: {
        B: { type: "string", minLength: 1 },
        A: {
          type: "object",
          properties: { x: { $ref: "#/$defs/B" }, y: { $ref: "#/$defs/B" } },
          required: ["x"],
        },
      },
      type: "object",
      properties: { p: { $ref: "#/$defs/A" }, q: { $ref: "#/$defs/A" } },
    };
    const compiled = compileSchema(schema);
    expect(compiled.check.supported).toBe(true);
    expect(compiled.validate!({ p: { x: "a" }, q: { x: "b", y: "c" } })).toBe(true);
    expect(compiled.validate!({ p: { x: "" } })).toBe(false);
  });
});

describe("pattern is checked with the unicode flag", () => {
  test("a pattern valid only without the u flag is rejected by the walk under the pattern keyword", () => {
    // `\-` is an identity escape without the u flag, but a syntax error with it.
    const schema = { type: "string", pattern: "\\-" };
    const check = checkSchema(schema);
    expect(check.supported).toBe(false);
    expect(check.issues).toEqual([{ path: "arguments.pattern", keyword: "pattern" }]);
    expect(compileSchema(schema).validate).toBeUndefined();
  });

  test("a pattern valid under the u flag is accepted", () => {
    const compiled = compileSchema({ type: "string", pattern: "^[a-z]+$" });
    expect(compiled.check.supported).toBe(true);
    expect(compiled.validate!("abc")).toBe(true);
    expect(compiled.validate!("ABC")).toBe(false);
  });
});

describe("anyOf and oneOf", () => {
  test("anyOf accepts any matching branch and rejects data matching none", () => {
    const compiled = compileSchema({
      type: "object",
      properties: { v: { anyOf: [{ type: "string" }, { type: "number" }] } },
    });
    expect(compiled.check.supported).toBe(true);
    expect(compiled.validate!({ v: "a" })).toBe(true);
    expect(compiled.validate!({ v: 1 })).toBe(true);
    expect(compiled.validate!({ v: true })).toBe(false);
  });

  test("oneOf accepts data matching exactly one branch", () => {
    const compiled = compileSchema({
      type: "object",
      properties: { v: { oneOf: [{ type: "string" }, { type: "number" }] } },
    });
    expect(compiled.check.supported).toBe(true);
    expect(compiled.validate!({ v: "a" })).toBe(true);
    expect(compiled.validate!({ v: 2 })).toBe(true);
    expect(compiled.validate!({ v: false })).toBe(false);
  });

  test("oneOf rejects data that matches two branches", () => {
    const compiled = compileSchema({
      type: "object",
      properties: { v: { oneOf: [{ type: "string" }, { type: "string", minLength: 1 }] } },
    });
    expect(compiled.check.supported).toBe(true);
    expect(compiled.validate!({ v: "x" })).toBe(false);
    expect(compiled.validate!({ v: "" })).toBe(true);
  });

  test("an empty or non-array combinator is rejected under its own keyword", () => {
    expect(checkSchema({ anyOf: [] }).issues).toEqual([{ path: "arguments.anyOf", keyword: "anyOf" }]);
    expect(checkSchema({ oneOf: "string" }).issues).toEqual([{ path: "arguments.oneOf", keyword: "oneOf" }]);
  });

  test("a branch is walked as a schema and reports its own path", () => {
    const check = checkSchema({ type: "object", properties: { x: { anyOf: [{ allOf: [] }] } } });
    expect(check.issues).toEqual([{ path: "arguments.properties.x.anyOf.0.allOf", keyword: "allOf" }]);
  });
});

describe("keywords that remain rejected", () => {
  const stillRejected: Array<{ keyword: string; value: unknown }> = [
    { keyword: "allOf", value: [{ type: "string" }] },
    { keyword: "not", value: { type: "string" } },
    { keyword: "if", value: { type: "string" } },
    { keyword: "then", value: { type: "string" } },
    { keyword: "else", value: { type: "string" } },
    { keyword: "propertyNames", value: { pattern: "^a" } },
    { keyword: "dependencies", value: { x: ["y"] } },
    { keyword: "dependentRequired", value: { x: ["y"] } },
    { keyword: "dependentSchemas", value: { x: { type: "object" } } },
    { keyword: "contains", value: { type: "string" } },
    { keyword: "minContains", value: 1 },
    { keyword: "maxContains", value: 2 },
    { keyword: "prefixItems", value: [{ type: "string" }] },
    { keyword: "unevaluatedProperties", value: false },
    { keyword: "unevaluatedItems", value: false },
    // Deferred: uniqueItems is quadratic in array length with non-scalar items;
    // patternProperties matches model-chosen property names against schema regexes.
    { keyword: "uniqueItems", value: true },
    { keyword: "patternProperties", value: { "^x-": { type: "string" } } },
    { keyword: "x-unknown", value: 1 },
  ];

  for (const { keyword, value } of stillRejected) {
    test(`${keyword} is rejected by name`, () => {
      const check = checkSchema({ type: "object", properties: { x: { [keyword]: value } } });
      expect(check.supported).toBe(false);
      expect(check.issues).toEqual([{ path: `arguments.properties.x.${keyword}`, keyword }]);
    });
  }

  test("tuple-form items is rejected", () => {
    expect(keywordsOf({ type: "array", items: [{ type: "string" }] })).toEqual(["items"]);
  });

  test("a $schema other than draft-07 is still rejected", () => {
    expect(keywordsOf({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" })).toEqual([
      "$schema",
    ]);
  });
});

describe("Tier B keywords", () => {
  test("multipleOf: 3 rejects 4 and accepts 6; non-positive or non-numeric values are rejected", () => {
    const compiled = compileSchema({ type: "number", multipleOf: 3 });
    expect(compiled.check.supported).toBe(true);
    expect(compiled.validate!(4)).toBe(false);
    expect(compiled.validate!(6)).toBe(true);
    for (const bad of [0, -2, "3", Number.POSITIVE_INFINITY]) {
      expect(keywordsOf({ type: "number", multipleOf: bad })).toEqual(["multipleOf"]);
    }
  });

  test("exclusiveMinimum: 0 rejects 0 and accepts 0.1", () => {
    const compiled = compileSchema({ type: "number", exclusiveMinimum: 0 });
    expect(compiled.check.supported).toBe(true);
    expect(compiled.validate!(0)).toBe(false);
    expect(compiled.validate!(0.1)).toBe(true);
    expect(keywordsOf({ type: "number", exclusiveMinimum: "0" })).toEqual(["exclusiveMinimum"]);
    expect(keywordsOf({ type: "number", exclusiveMinimum: Number.NaN })).toEqual(["exclusiveMinimum"]);
  });

  test("exclusiveMaximum: 10 rejects 10 and accepts 9", () => {
    const compiled = compileSchema({ type: "number", exclusiveMaximum: 10 });
    expect(compiled.check.supported).toBe(true);
    expect(compiled.validate!(10)).toBe(false);
    expect(compiled.validate!(9)).toBe(true);
    expect(keywordsOf({ type: "number", exclusiveMaximum: null })).toEqual(["exclusiveMaximum"]);
  });
});

describe("recursive references are refused", () => {
  /** A recursive schema is refused by the walk, with the recursion message, and never compiled. */
  function expectRecursionRefused(schema: unknown): void {
    const check = checkSchema(schema);
    expect(check.supported).toBe(false);
    expect(check.issues.some((issue) => issue.keyword === "$ref" && issue.message?.includes("recursive reference") === true)).toBe(
      true,
    );
    expect(compileSchema(schema).validate).toBeUndefined();
  }

  test("a linked list (N.properties.next = $ref N) is rejected", () => {
    const schema = {
      $defs: {
        N: {
          type: "object",
          properties: { value: { type: "integer" }, next: { $ref: "#/$defs/N" } },
          additionalProperties: false,
        },
      },
      type: "object",
      properties: { head: { $ref: "#/$defs/N" } },
    };
    expectRecursionRefused(schema);
    expect(checkSchema(schema).issues[0]?.message).toContain("recursive reference");
  });

  test("reviewer schema (a): a property reaches a definition whose anyOf branches re-enter it is rejected", () => {
    const schema = {
      type: "object",
      properties: { v: { $ref: "#/$defs/a" } },
      $defs: {
        a: {
          anyOf: [
            { type: "object", required: ["x"], properties: { x: { $ref: "#/$defs/a" } } },
            { type: "object", required: ["x"], properties: { x: { $ref: "#/$defs/a" } } },
          ],
        },
      },
    };
    expectRecursionRefused(schema);
  });

  test("reviewer schema (b): oneOf of two refs to N, each re-entered from N's own property, is rejected", () => {
    const schema = {
      type: "object",
      properties: { n: { oneOf: [{ $ref: "#/$defs/N" }, { $ref: "#/$defs/N" }] } },
      $defs: {
        N: {
          type: "object",
          properties: { n: { oneOf: [{ $ref: "#/$defs/N" }, { $ref: "#/$defs/N" }] } },
        },
      },
    };
    expectRecursionRefused(schema);
  });

  test("anyOf of two refs to N, re-entered from N's own property, is rejected", () => {
    const schema = {
      type: "object",
      properties: { n: { anyOf: [{ $ref: "#/$defs/N" }, { $ref: "#/$defs/N" }] } },
      $defs: {
        N: {
          type: "object",
          properties: { n: { anyOf: [{ $ref: "#/$defs/N" }, { $ref: "#/$defs/N" }] } },
        },
      },
    };
    expectRecursionRefused(schema);
  });

  test("a binary tree with left and right properties, each $ref N, is rejected", () => {
    const schema = {
      type: "object",
      properties: { root: { $ref: "#/$defs/N" } },
      $defs: {
        N: {
          type: "object",
          properties: {
            value: { type: "integer" },
            left: { $ref: "#/$defs/N" },
            right: { $ref: "#/$defs/N" },
          },
        },
      },
    };
    expectRecursionRefused(schema);
  });

  test("anyOf:[$ref N, null] on a property is rejected", () => {
    const schema = {
      type: "object",
      properties: { head: { $ref: "#/$defs/N" } },
      $defs: {
        N: {
          type: "object",
          properties: { next: { anyOf: [{ $ref: "#/$defs/N" }, { type: "null" }] } },
        },
      },
    };
    expectRecursionRefused(schema);
  });

  test("oneOf:[$ref N, {type:string}] on a property is rejected", () => {
    const schema = {
      type: "object",
      properties: { head: { $ref: "#/$defs/N" } },
      $defs: {
        N: {
          type: "object",
          properties: { next: { oneOf: [{ $ref: "#/$defs/N" }, { type: "string" }] } },
        },
      },
    };
    expectRecursionRefused(schema);
  });

  test("an unproductive cycle (A = anyOf[$ref A, string]) is rejected at the re-entering reference", () => {
    const schema = {
      $defs: { A: { anyOf: [{ $ref: "#/$defs/A" }, { type: "string" }] } },
      type: "object",
      properties: { a: { $ref: "#/$defs/A" } },
    };
    const check = checkSchema(schema);
    expect(check.supported).toBe(false);
    expect(check.issues).toEqual([
      { path: "arguments.$defs.A.anyOf.0.$ref", keyword: "$ref", message: "recursive reference is not supported" },
    ]);
    expect(compileSchema(schema).validate).toBeUndefined();
  });

  test("the root-level form of the same cycle is rejected (root $ref with $defs)", () => {
    const schema = {
      $defs: { A: { anyOf: [{ $ref: "#/$defs/A" }, { type: "string" }] } },
      $ref: "#/$defs/A",
    };
    expect(checkSchema(schema).supported).toBe(false);
    expect(keywordsOf(schema)).toContain("$ref");
  });

  test("a cycle that passes through a property is rejected too", () => {
    const schema = {
      $defs: {
        A: {
          anyOf: [
            { type: "object", properties: { next: { $ref: "#/$defs/A" } } },
            { type: "string" },
          ],
        },
      },
      type: "object",
      properties: { a: { $ref: "#/$defs/A" } },
    };
    expectRecursionRefused(schema);
  });

  test("a descent in a sibling branch does not hide a same-instance cycle on another branch", () => {
    const schema = {
      $defs: {
        A: {
          anyOf: [
            { type: "object", properties: { x: { type: "string" } } },
            { $ref: "#/$defs/A" },
          ],
        },
      },
      type: "object",
      properties: { a: { $ref: "#/$defs/A" } },
    };
    expect(checkSchema(schema).supported).toBe(false);
    expect(checkSchema(schema).issues[0]?.message).toBe("recursive reference is not supported");
  });
});

describe("static evaluation bound", () => {
  /**
   * d0 = string; d_i = anyOf[$ref d_{i-1}, $ref d_{i-1}]. The bound of d_n is
   * 2^(n+1) - 1: every level re-checks the same instance through two branches.
   * Built small on purpose; the schema is never compiled when refused.
   */
  function fanOut(levels: number): Record<string, unknown> {
    const defs: Record<string, unknown> = { d0: { type: "string" } };
    for (let i = 1; i <= levels; i += 1) {
      const previous = `#/$defs/d${i - 1}`;
      defs[`d${i}`] = { anyOf: [{ $ref: previous }, { $ref: previous }] };
    }
    return {
      $defs: defs,
      type: "object",
      properties: { a: { $ref: `#/$defs/d${levels}` } },
    };
  }

  test("fan-out of 22 through shared definitions is refused before compile, quickly", () => {
    const schema = fanOut(22);
    const started = performance.now();
    const compiled = compileSchema(schema);
    const elapsed = performance.now() - started;

    expect(compiled.check.supported).toBe(false);
    expect(compiled.check.issues).toEqual([
      { path: "arguments", keyword: "$ref", message: "evaluation bound exceeds limit" },
    ]);
    expect(compiled.validate).toBeUndefined();
    expect(elapsed).toBeLessThan(200);
  });

  test("fan-out of 10 is accepted, reports its bound, and validates", () => {
    const compiled = compileSchema(fanOut(10));
    expect(compiled.check.supported).toBe(true);
    // d10 = 2^11 - 1 = 2047; the root adds itself: 2048.
    expect(compiled.bound).toBe(2048);
    expect(compiled.validate!({ a: "x" })).toBe(true);
    expect(compiled.validate!({ a: 1 })).toBe(false);
  });

  test("a linear chain of 60 nested references is accepted", () => {
    const defs: Record<string, unknown> = { d0: { type: "string" } };
    for (let i = 1; i <= 60; i += 1) defs[`d${i}`] = { $ref: `#/$defs/d${i - 1}` };
    const compiled = compileSchema({ $defs: defs, type: "object", properties: { a: { $ref: "#/$defs/d60" } } });
    expect(compiled.check.supported).toBe(true);
    expect(compiled.validate!({ a: "x" })).toBe(true);
    expect(compiled.validate!({ a: 1 })).toBe(false);
  });

  test("a 1,000-long nested $ref chain returns unsupported rather than throwing", () => {
    const defs: Record<string, unknown> = { d0: { type: "string" } };
    for (let i = 1; i <= 999; i += 1) defs[`d${i}`] = { $ref: `#/$defs/d${i - 1}` };
    const schema = { $defs: defs, type: "object", properties: { a: { $ref: "#/$defs/d999" } } };

    let check: ReturnType<typeof checkSchema> | undefined;
    expect(() => {
      check = checkSchema(schema);
    }).not.toThrow();
    expect(check!.supported).toBe(false);
    expect(check!.issues).toHaveLength(1);
    expect(check!.issues[0]).toMatchObject({ keyword: "$ref", message: "reference chain too deep" });
    expect(MAX_REF_DEPTH).toBe(64);
  });

  test("a hundred sibling references to one definition are accepted", () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 100; i += 1) properties[`p${i}`] = { $ref: "#/$defs/x" };
    const compiled = compileSchema({ $defs: { x: { type: "string" } }, type: "object", properties });
    expect(compiled.check.supported).toBe(true);
    expect(compiled.validate!({ p5: "a" })).toBe(true);
    expect(compiled.validate!({ p5: 1 })).toBe(false);
  });

  test("the limits are exported with the agreed values", () => {
    expect(MAX_SCHEMA_NODES).toBe(10_000);
    expect(MAX_EVAL_PATHS).toBe(16_384);
    expect(MAX_EVAL_WORK).toBe(10_000_000);
    expect(MAX_REF_DEPTH).toBe(64);
    expect(MAX_ARG_DEPTH).toBe(64);
  });

  test("a schema over the node budget is refused as too large", () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < MAX_SCHEMA_NODES; i += 1) properties[`p${i}`] = { type: "string" };
    const check = checkSchema({ type: "object", properties });
    expect(check.supported).toBe(false);
    expect(check.issues).toEqual([{ path: "arguments", keyword: "$ref", message: "schema too large" }]);
  });

  test("a literal nesting deeper than 64 is refused with the depth keyword", () => {
    let schema: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 70; i += 1) schema = { type: "object", properties: { n: schema } };
    const check = checkSchema(schema);
    expect(check.supported).toBe(false);
    expect(check.issues[0]?.keyword).toBe("depth");
    expect(check.issues[0]?.message).toBe("schema nesting too deep");
  });

  test("a getter that throws during the walk becomes an issue, not an exception", () => {
    const schema: Record<string, unknown> = { type: "object" };
    Object.defineProperty(schema, "properties", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    let check: ReturnType<typeof checkSchema> | undefined;
    expect(() => {
      check = checkSchema(schema);
    }).not.toThrow();
    expect(check!.supported).toBe(false);
  });
});

describe("evaluation work bound", () => {
  /**
   * d0 = string; d_i = anyOf[$ref d_{i-1}, $ref d_{i-1}] for i = 1..12, so d12 has
   * bound 2^13 - 1 = 8191. The root's `a` is an array of d12, so the schema's bound
   * is 1 + (1 + 8191) = 8193: accepted (under MAX_EVAL_PATHS), but a 2,000-item
   * argument costs about 8193 * 2002, above MAX_EVAL_WORK.
   */
  function multiplicity(): Record<string, unknown> {
    const defs: Record<string, unknown> = { d0: { type: "string" } };
    for (let i = 1; i <= 12; i += 1) {
      const previous = `#/$defs/d${i - 1}`;
      defs[`d${i}`] = { anyOf: [{ $ref: previous }, { $ref: previous }] };
    }
    return {
      type: "object",
      properties: { a: { type: "array", items: { $ref: "#/$defs/d12" } } },
      $defs: defs,
    };
  }

  test("the multiplicity schema is accepted with bound 8193", () => {
    const compiled = compileSchema(multiplicity());
    expect(compiled.check.supported).toBe(true);
    expect(compiled.bound).toBe(8193);
    expect(compiled.bound! * 2002).toBeGreaterThan(MAX_EVAL_WORK);
  });

  test("2,000 array items are refused as too large before Ajv runs, quickly", () => {
    const compiled = compileSchema(multiplicity());
    expect(compiled.validate).toBeDefined();

    const started = performance.now();
    const result = validateArguments(compiled.validate!, { a: Array(2000).fill(1) });
    const elapsed = performance.now() - started;

    expect(result).toEqual({
      ok: false,
      path: "arguments",
      expected: "arguments small enough for this schema",
      received: "too large",
      message: "arguments are too large for this tool's schema.",
    });
    expect(elapsed).toBeLessThan(100);
  });

  test("a small valid argument against the multiplicity schema validates", () => {
    const compiled = compileSchema(multiplicity());
    expect(validateArguments(compiled.validate!, { a: ["x"] })).toEqual({ ok: true });
  });

  test("a small valid argument against a small schema validates", () => {
    const compiled = compileSchema({ type: "object", properties: { n: { type: "integer" } } });
    expect(compiled.bound).toBe(2);
    expect(validateArguments(compiled.validate!, { n: 1 })).toEqual({ ok: true });
  });
});

describe("argument nesting", () => {
  test("arguments nested 100 deep are refused before validation, without throwing", () => {
    const validate = neverValidate();
    let args: unknown = {};
    for (let i = 0; i < 100; i += 1) args = { n: args };

    let result: ReturnType<typeof validateArguments> | undefined;
    expect(() => {
      result = validateArguments(validate, args);
    }).not.toThrow();
    expect(result).toEqual({
      ok: false,
      path: "arguments",
      expected: "nesting depth of at most 64",
      received: "deeper nesting",
      message: "arguments are nested too deeply.",
    });
  });

  test("arguments nested 40 deep are accepted when the schema does not constrain them", () => {
    const compiled = compileSchema({ type: "object" });
    expect(compiled.check.supported).toBe(true);

    let node: Record<string, unknown> = {};
    for (let i = 0; i < 38; i += 1) node = { next: node };
    const args = { head: node };

    expect(validateArguments(compiled.validate!, args)).toEqual({ ok: true });
  });

  test("a validator that throws a RangeError yields a failure, not an exception", () => {
    const throwing = (() => {
      throw new RangeError("Maximum call stack size exceeded");
    }) as unknown as ValidateFunction;
    Object.assign(throwing, { errors: null });

    const result = validateArguments(throwing, { a: 1 });
    expect(result).toEqual({
      ok: false,
      path: "arguments",
      expected: "bounded nesting depth",
      received: "deeper nesting",
      message: "arguments are nested too deeply.",
    });
  });
});
