/**
 * Input-schema support and argument validation (spec §7.2).
 *
 * The installed UTCP SDK ships no JSON Schema validator, so the adapter owns
 * validation. Two separate mechanisms run in a fixed order:
 *
 * 1. An explicit schema walk that decides whether the schema is inside the
 *    supported subset. It runs once, when the catalog is compiled at
 *    readiness; `describe` and `call` read that frozen verdict instead of
 *    re-walking the schema, so an unsupported schema is reported precisely
 *    rather than surfacing as an Ajv internal error. The walk also bounds the
 *    schema before Ajv sees it: a literal node budget, a literal nesting limit,
 *    a `$ref` chain limit, refusal of recursive references, and a static
 *    evaluation bound (see `evaluationBound`) that rejects fan-out through
 *    shared definitions.
 * 2. Ajv compilation with coercion, defaults and removal all disabled, so the
 *    arguments that reach the transport are exactly the arguments supplied.
 *    Before Ajv runs, the arguments are checked against the schema's bound
 *    times their node count (`MAX_EVAL_WORK`).
 *
 * Local references are supported: `$ref` only to `#/$defs/<name>` or
 * `#/definitions/<name>` in the root schema, and never recursively. Every other
 * reference form, and every keyword outside the table below, is rejected by
 * name. A schema outside the subset stays discoverable and describable but is
 * never executable.
 */

import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import type { JsonSchema } from "@utcp/sdk";
import { displayText, type SchemaIssue } from "./errors.js";

/**
 * Schema objects the walk may visit before the schema is refused as too large.
 * Counts literal schema nodes only: a definition reached by several `$ref`s is
 * still counted once here.
 */
export const MAX_SCHEMA_NODES = 10_000;
/**
 * Upper bound on validation paths one instance may take through a schema. Recursive
 * references are refused, so the count is exact: each `anyOf`/`oneOf` branch and
 * each `$ref` re-checks the same instance, and n levels that each reference the
 * previous one through two branches cost 2^n paths.
 */
export const MAX_EVAL_PATHS = 16_384;
/**
 * Upper bound on the validator's work for one call: the schema's evaluation bound
 * times the number of argument nodes. Arguments above it are refused before Ajv runs,
 * because a schema that is cheap for one value can be expensive for a long array.
 */
export const MAX_EVAL_WORK = 10_000_000;
/** Nested `$ref` targets along one resolution path. */
export const MAX_REF_DEPTH = 64;
/** Nesting depth of the arguments object, measured before validation. */
export const MAX_ARG_DEPTH = 64;

/** Literal nesting depth of schema objects, as the walk recurses. */
const MAX_SCHEMA_DEPTH = 64;
/** Nodes visited while measuring arguments before they are refused as too large. */
const MAX_ARG_NODES = 100_000;
/** Maximum number of issues carried in one verdict. */
const MAX_ISSUES = 8;

/** Keywords the adapter validates. */
const SUPPORTED_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "items",
  "enum",
  "const",
  "additionalProperties",
  "pattern",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "default",
  "title",
  "description",
  "examples",
  "format",
  "$schema",
  // Local references and their containers (root only; see walk()).
  "$ref",
  "$defs",
  "definitions",
  // Combinators; each branch is walked as a schema.
  "anyOf",
  "oneOf",
  // Numeric constraints (Tier B).
  "multipleOf",
  "exclusiveMinimum",
  "exclusiveMaximum",
]);

/**
 * Keywords explicitly rejected, with the keyword itself as the reported name.
 * Anything in neither set is also rejected: the walk fails closed.
 *
 * `uniqueItems` is quadratic in the array length when the items are not scalars,
 * and `patternProperties` matches model-chosen property names against schema
 * regular expressions. Both are deferred.
 */
const REJECTED_KEYWORDS = new Set([
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "propertyNames",
  "dependencies",
  "dependentRequired",
  "dependentSchemas",
  "contains",
  "minContains",
  "maxContains",
  "prefixItems",
  "unevaluatedProperties",
  "unevaluatedItems",
  "uniqueItems",
  "patternProperties",
]);

const SUPPORTED_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
]);

const DRAFT_07_URIS = new Set([
  "http://json-schema.org/draft-07/schema#",
  "http://json-schema.org/draft-07/schema",
  "https://json-schema.org/draft-07/schema#",
  "https://json-schema.org/draft-07/schema",
]);

/** A local reference: container name and member name, nothing else. */
const REF_PATTERN = /^#\/(\$defs|definitions)\/([A-Za-z0-9_-]{1,64})$/;
/** A member name inside `$defs` or `definitions`. */
const DEFINITION_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * Keys that may sit beside `$ref`. Draft-07 ignores siblings of `$ref`, so any
 * other sibling would silently not apply; the adapter refuses that instead.
 */
const REF_SIBLING_ANNOTATIONS = new Set(["title", "description", "examples", "default"]);

/**
 * A format is known only if Ajv itself has a validator for it: the support
 * table must not outrun the validator (spec §7.2).
 */
function isKnownFormat(name: string): boolean {
  const formats = getAjv().formats as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(formats, name) && formats[name] !== false;
}

export interface SchemaCheck {
  supported: boolean;
  issues: SchemaIssue[];
  /** Static evaluation bound (validation paths per instance); set only when supported. */
  bound?: number;
}

export type ArgumentValidation =
  | { ok: true }
  | { ok: false; path: string; expected: string; received: string; message: string };

export interface CompiledSchema {
  check: SchemaCheck;
  validate?: ValidateFunction;
  /** Evaluation bound of the compiled schema; set only when `validate` is set. */
  bound?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * Dotted schema path, matching the spec's error example
 * (`arguments.properties.filter.oneOf`), not a JSON pointer.
 */
function schemaPath(base: string, key: string): string {
  return `${base}.${key}`;
}

function pushIssue(issues: SchemaIssue[], path: string, keyword: string): void {
  if (issues.length >= MAX_ISSUES) return;
  issues.push({ path: path.length === 0 ? "arguments" : path, keyword });
}

/**
 * Thrown to stop the check at once. Carries the single issue that ends it, so
 * a limit that fires replaces the list instead of appending to it.
 */
class SchemaHalt extends Error {
  readonly issue: SchemaIssue;

  constructor(issue: SchemaIssue) {
    super(issue.keyword);
    this.name = "SchemaHalt";
    this.issue = issue;
  }
}

function halt(path: string, keyword: string, message: string): never {
  throw new SchemaHalt({ path: path.length === 0 ? "arguments" : path, keyword, message });
}

interface WalkContext {
  readonly root: unknown;
  readonly issues: SchemaIssue[];
  nodes: number;
}

function walk(schema: unknown, path: string, depth: number, ctx: WalkContext): void {
  if (ctx.issues.length >= MAX_ISSUES) return;
  if (depth > MAX_SCHEMA_DEPTH) halt(path, "depth", "schema nesting too deep");
  if (!isRecord(schema)) {
    // A boolean or otherwise non-object schema has no keyword to point at.
    pushIssue(ctx.issues, path, "<non-object schema>");
    return;
  }

  ctx.nodes += 1;
  if (ctx.nodes > MAX_SCHEMA_NODES) halt("arguments", "$ref", "schema too large");

  const isRoot = schema === ctx.root;
  const hasRef = hasOwn(schema, "$ref");

  for (const [keyword, value] of Object.entries(schema)) {
    const childPath = schemaPath(path, keyword);

    if (hasRef && keyword !== "$ref" && !REF_SIBLING_ANNOTATIONS.has(keyword)) {
      pushIssue(ctx.issues, childPath, "$ref");
      continue;
    }
    if (REJECTED_KEYWORDS.has(keyword)) {
      pushIssue(ctx.issues, childPath, keyword);
      continue;
    }
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      // Fail closed: a keyword the adapter has no rule for is not silently ignored.
      pushIssue(ctx.issues, childPath, keyword);
      continue;
    }

    switch (keyword) {
      case "$schema": {
        if (typeof value !== "string" || !DRAFT_07_URIS.has(value)) {
          pushIssue(ctx.issues, childPath, "$schema");
        }
        break;
      }
      case "$ref": {
        const match = typeof value === "string" ? REF_PATTERN.exec(value) : null;
        if (match === null) {
          pushIssue(ctx.issues, childPath, "$ref");
          break;
        }
        const container = isRecord(ctx.root) ? ctx.root[match[1] ?? ""] : undefined;
        if (!isRecord(container) || !hasOwn(container, match[2] ?? "")) {
          pushIssue(ctx.issues, childPath, "$ref");
        }
        break;
      }
      case "$defs":
      case "definitions": {
        // Definition containers exist only at the root, so a reference target
        // is always addressable by the one fixed pointer form.
        if (!isRoot || !isRecord(value)) {
          pushIssue(ctx.issues, childPath, keyword);
          break;
        }
        for (const [name, subSchema] of Object.entries(value)) {
          const memberPath = schemaPath(childPath, name);
          if (!DEFINITION_NAME_PATTERN.test(name)) {
            pushIssue(ctx.issues, memberPath, keyword);
            continue;
          }
          walk(subSchema, memberPath, depth + 1, ctx);
        }
        break;
      }
      case "anyOf":
      case "oneOf": {
        if (!Array.isArray(value) || value.length === 0) {
          pushIssue(ctx.issues, childPath, keyword);
          break;
        }
        value.forEach((branch, index) => {
          walk(branch, schemaPath(childPath, String(index)), depth + 1, ctx);
        });
        break;
      }
      case "type": {
        const types = Array.isArray(value) ? value : [value];
        if (types.length === 0) {
          pushIssue(ctx.issues, childPath, "type");
          break;
        }
        for (const type of types) {
          if (typeof type !== "string" || !SUPPORTED_TYPES.has(type)) {
            pushIssue(ctx.issues, childPath, "type");
            break;
          }
        }
        break;
      }
      case "properties": {
        if (!isRecord(value)) {
          pushIssue(ctx.issues, childPath, "properties");
          break;
        }
        for (const [name, subSchema] of Object.entries(value)) {
          walk(subSchema, schemaPath(childPath, name), depth + 1, ctx);
        }
        break;
      }
      case "items": {
        if (Array.isArray(value)) {
          // Tuple form is explicitly unsupported.
          pushIssue(ctx.issues, childPath, "items");
          break;
        }
        walk(value, childPath, depth + 1, ctx);
        break;
      }
      case "additionalProperties": {
        if (typeof value !== "boolean") walk(value, childPath, depth + 1, ctx);
        break;
      }
      case "required": {
        if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
          pushIssue(ctx.issues, childPath, "required");
        }
        break;
      }
      case "enum": {
        if (!Array.isArray(value) || value.length === 0) pushIssue(ctx.issues, childPath, "enum");
        break;
      }
      case "pattern": {
        if (typeof value !== "string") {
          pushIssue(ctx.issues, childPath, "pattern");
          break;
        }
        try {
          // Ajv compiles `pattern` with the unicode flag, so a pattern that only
          // compiles without it (for example `\-`) would fail later, not here.
          new RegExp(value, "u");
        } catch {
          pushIssue(ctx.issues, childPath, "pattern");
        }
        break;
      }
      case "format": {
        if (typeof value !== "string" || !isKnownFormat(value)) {
          pushIssue(ctx.issues, childPath, "format");
        }
        break;
      }
      case "minimum":
      case "maximum":
      case "minLength":
      case "maxLength": {
        if (typeof value !== "number" || Number.isNaN(value)) pushIssue(ctx.issues, childPath, keyword);
        break;
      }
      case "exclusiveMinimum":
      case "exclusiveMaximum": {
        if (typeof value !== "number" || !Number.isFinite(value)) pushIssue(ctx.issues, childPath, keyword);
        break;
      }
      case "multipleOf": {
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
          pushIssue(ctx.issues, childPath, keyword);
        }
        break;
      }
      case "title":
      case "description": {
        if (typeof value !== "string") pushIssue(ctx.issues, childPath, keyword);
        break;
      }
      case "examples": {
        if (!Array.isArray(value)) pushIssue(ctx.issues, childPath, "examples");
        break;
      }
      default:
        break;
    }
  }
}

/** Saturation point for the evaluation bound: anything above the limit is equal to it. */
const BOUND_CAP = MAX_EVAL_PATHS + 1;

function addBound(a: number, b: number): number {
  return Math.min(BOUND_CAP, a + b);
}

interface BoundState {
  readonly root: Record<string, unknown>;
  /** Finished bound per reference target, keyed `<container>/<name>`. */
  readonly memo: Map<string, number>;
  /** Targets on the current resolution path. A repeat is a cycle; the size is the ref depth. */
  readonly inProgress: Set<string>;
}

/**
 * Validation paths for one instance of `node`: 1, plus the bounds of every child
 * schema (properties values, items, the additionalProperties schema, and the
 * anyOf/oneOf branches). A `$ref` node takes the bound of its target.
 *
 * Recursion is refused (see boundOfRef), so the reference graph is acyclic and
 * this memoized sum is an exact per-instance count of validation paths. Fan-out
 * cannot hide inside recursion: a review found schemas where two branches each
 * descend into the same recursive definition, which gives 2^depth paths for one
 * instance. Those schemas now fail at the cycle, not at the count.
 */
function boundOfNode(node: Record<string, unknown>, path: string, state: BoundState): number {
  if (hasOwn(node, "$ref") && typeof node["$ref"] === "string") {
    return boundOfRef(node["$ref"], schemaPath(path, "$ref"), state);
  }

  let bound = 1;
  const child = (value: unknown, childPath: string): void => {
    if (isRecord(value)) bound = addBound(bound, boundOfNode(value, childPath, state));
  };

  if (isRecord(node["properties"])) {
    for (const [name, sub] of Object.entries(node["properties"])) {
      child(sub, schemaPath(schemaPath(path, "properties"), name));
    }
  }
  if (isRecord(node["items"])) child(node["items"], schemaPath(path, "items"));
  if (isRecord(node["additionalProperties"])) {
    child(node["additionalProperties"], schemaPath(path, "additionalProperties"));
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = node[key];
    if (!Array.isArray(branches)) continue;
    branches.forEach((branch, index) => child(branch, schemaPath(schemaPath(path, key), String(index))));
  }
  return bound;
}

function boundOfRef(value: string, path: string, state: BoundState): number {
  const match = REF_PATTERN.exec(value);
  if (match === null) halt(path, "$ref", "reference is not a local definition");
  const container = match[1] ?? "";
  const name = match[2] ?? "";
  const key = `${container}/${name}`;

  // The target is already being resolved on this path, so the schema refers back
  // to itself. Recursion is refused whether or not a property sits in between.
  if (state.inProgress.has(key)) halt(path, "$ref", "recursive reference is not supported");

  const finished = state.memo.get(key);
  if (finished !== undefined) return finished;

  if (state.inProgress.size >= MAX_REF_DEPTH) halt(path, "$ref", "reference chain too deep");

  const members = state.root[container];
  const target = isRecord(members) ? members[name] : undefined;
  if (!isRecord(target)) halt(path, "$ref", "reference is not a local definition");

  state.inProgress.add(key);
  let bound: number;
  try {
    bound = boundOfNode(target, `arguments.${container}.${name}`, state);
  } finally {
    state.inProgress.delete(key);
  }
  // Acyclic, so the result depends only on the target: memoize it unconditionally.
  state.memo.set(key, bound);
  return bound;
}

/**
 * Static bound on the validation paths one instance can take through the walked
 * schema. Recursive references are refused, so the reference graph is acyclic,
 * each target's bound is computed once and memoized, and the total work is
 * bounded by the schema's node count. A bound above MAX_EVAL_PATHS is refused.
 */
function evaluationBound(root: Record<string, unknown>): number {
  const state: BoundState = { root, memo: new Map(), inProgress: new Set() };
  const bound = boundOfNode(root, "arguments", state);
  if (bound > MAX_EVAL_PATHS) {
    halt("arguments", "$ref", "evaluation bound exceeds limit");
  }
  return bound;
}

/**
 * Runs the explicit subset walk and the static bounds. Never throws: a limit
 * that fires, a stack overflow, or any unexpected failure becomes an issue, so
 * the schema is refused rather than reaching Ajv.
 */
export function checkSchema(schema: unknown): SchemaCheck {
  const ctx: WalkContext = { root: schema, issues: [], nodes: 0 };
  let bound: number | undefined;
  try {
    walk(schema, "arguments", 0, ctx);
    if (ctx.issues.length === 0 && isRecord(schema)) {
      bound = evaluationBound(schema);
    }
  } catch (error) {
    const issue = toIssue(error);
    ctx.issues.length = 0;
    ctx.issues.push(issue);
    bound = undefined;
  }
  const supported = ctx.issues.length === 0;
  return supported && bound !== undefined
    ? { supported, issues: ctx.issues, bound }
    : { supported, issues: ctx.issues };
}

function toIssue(error: unknown): SchemaIssue {
  if (error instanceof SchemaHalt) return error.issue;
  if (error instanceof RangeError) {
    return { path: "arguments", keyword: "depth", message: "schema nesting too deep" };
  }
  return { path: "arguments", keyword: "<internal>", message: "schema check failed" };
}

let sharedAjv: Ajv | null = null;

function getAjv(): Ajv {
  if (sharedAjv === null) {
    sharedAjv = new Ajv({
      strict: true,
      allErrors: true,
      coerceTypes: false,
      useDefaults: false,
      removeAdditional: false,
    });
    addFormats(sharedAjv);
  }
  return sharedAjv;
}

/**
 * Compiled validators keyed by schema identity. A new tool definition is a new
 * object, so it compiles afresh; the frozen catalog never mutates a schema in
 * place, which is what makes identity a sound cache key.
 */
const compiled = new WeakMap<object, CompiledSchema>();

/** Evaluation bound of each validator compiled here, read by validateArguments. */
const evaluationBounds = new WeakMap<ValidateFunction, number>();

/**
 * Checks and compiles a tool input schema.
 *
 * The walk decides support; Ajv only validates arguments. Because the catalog
 * is frozen at readiness, one compilation per tool definition is enough, and a
 * changed definition (a new object) is recompiled rather than reused.
 */
export function compileSchema(schema: unknown): CompiledSchema {
  const check = checkSchema(schema);
  if (!check.supported) return { check };

  const key = typeof schema === "object" && schema !== null ? schema : null;
  if (key !== null) {
    const cached = compiled.get(key);
    if (cached !== undefined && cached.validate !== undefined) return cached;
  }

  try {
    const validate = getAjv().compile(schema as JsonSchema);
    const bound = check.bound ?? MAX_EVAL_PATHS;
    evaluationBounds.set(validate, bound);
    const result: CompiledSchema = { check, validate, bound };
    if (key !== null) compiled.set(key, result);
    return result;
  } catch (error) {
    // The support table and the validator disagreed. Spec §7.2 asks for Ajv's
    // own message here, because the disagreement is a defect in the adapter's
    // table rather than something the manual author chose; the text describes
    // the schema, and is bounded like every other projected string.
    const message = typeof (error as { message?: unknown })?.message === "string"
      ? ((error as { message: string }).message)
      : "Ajv rejected the schema without a message.";
    return {
      check: {
        supported: false,
        issues: [{ path: "arguments", keyword: "compile", message: displayText(message, 300) }],
      },
    };
  }
}

function receivedType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function instanceToPath(base: string, instancePath: string): string {
  const suffix = instancePath.split("/").filter((part) => part.length > 0).join(".");
  return suffix.length > 0 ? `${base}.${suffix}` : base;
}

function readAtPath(value: unknown, instancePath: string): unknown {
  if (instancePath === "") return value;
  let current: unknown = value;
  for (const rawPart of instancePath.split("/").slice(1)) {
    const part = rawPart.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      current = current[Number(part)];
    } else if (isRecord(current)) {
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function describeAjvError(error: ErrorObject, data: unknown, base: string): ArgumentValidation {
  const path = instanceToPath(base, error.instancePath);
  const at = readAtPath(data, error.instancePath);

  switch (error.keyword) {
    case "type": {
      const expected = String((error.params as { type?: unknown }).type ?? "the declared type");
      return {
        ok: false,
        path,
        expected,
        received: receivedType(at),
        message: `${path} must be ${expected} (received ${receivedType(at)}).`,
      };
    }
    case "required": {
      const missing = String((error.params as { missingProperty?: unknown }).missingProperty ?? "");
      // Nested `required` reports the parent instance path, not the root.
      const parentPath = instanceToPath(base, error.instancePath);
      const missingPath = `${parentPath}.${missing}`;
      return {
        ok: false,
        path: missingPath,
        expected: "required property",
        received: "missing",
        message: `${missingPath} is required but was not supplied.`,
      };
    }
    case "additionalProperties": {
      const extra = String((error.params as { additionalProperty?: unknown }).additionalProperty ?? "");
      const parentPath = instanceToPath(base, error.instancePath);
      const extraPath = `${parentPath}.${extra}`;
      return {
        ok: false,
        path: extraPath,
        expected: "no additional properties (additionalProperties: false)",
        received: "unexpected property",
        message: `${extraPath} is not accepted by this tool's schema.`,
      };
    }
    case "enum":
    case "const": {
      return {
        ok: false,
        path,
        expected: error.keyword === "const" ? "the declared constant" : "one of the allowed values",
        received: receivedType(at),
        message: `${path} does not match ${error.keyword} in the tool's schema.`,
      };
    }
    default: {
      return {
        ok: false,
        path,
        expected: error.keyword,
        received: receivedType(at),
        message: `${path} violates '${error.keyword}' in the tool's schema.`,
      };
    }
  }
}

interface ArgumentMeasure {
  /** Nested deeper than MAX_ARG_DEPTH, or more than MAX_ARG_NODES values. */
  readonly tooDeep: boolean;
  /** Values visited, the root and every leaf included. Complete only when not `tooDeep`. */
  readonly nodes: number;
}

/**
 * Measures the arguments. Iterative: an explicit stack, so no input depth can
 * overflow the call stack. Stops early once either limit is exceeded.
 */
function measureArguments(value: unknown): ArgumentMeasure {
  const stack: Array<{ value: unknown; level: number }> = [{ value, level: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) break;
    visited += 1;
    if (visited > MAX_ARG_NODES) return { tooDeep: true, nodes: visited };

    const { value: current, level } = entry;
    let children: unknown[] | null = null;
    if (Array.isArray(current)) {
      children = current;
    } else if (isRecord(current)) {
      children = Object.values(current);
    }
    if (children === null) continue;
    if (level + 1 > MAX_ARG_DEPTH) return { tooDeep: true, nodes: visited };
    for (const child of children) stack.push({ value: child, level: level + 1 });
    if (visited + stack.length > MAX_ARG_NODES) return { tooDeep: true, nodes: visited };
  }
  return { tooDeep: false, nodes: visited };
}

const ARGUMENTS_TOO_DEEP: ArgumentValidation = {
  ok: false,
  path: "arguments",
  expected: "nesting depth of at most 64",
  received: "deeper nesting",
  message: "arguments are nested too deeply.",
};

const ARGUMENTS_TOO_LARGE: ArgumentValidation = {
  ok: false,
  path: "arguments",
  expected: "arguments small enough for this schema",
  received: "too large",
  message: "arguments are too large for this tool's schema.",
};

/**
 * Validates arguments against a compiled schema. The object is validated
 * whole: no property is dropped, defaulted or coerced. Arguments nested beyond
 * MAX_ARG_DEPTH, arguments whose work (schema bound times node count) exceeds
 * MAX_EVAL_WORK, or a validator that throws on them, fail without dispatch. A
 * validator this module did not compile is assumed to have the largest bound.
 */
export function validateArguments(validate: ValidateFunction, args: unknown): ArgumentValidation {
  const measured = measureArguments(args);
  if (measured.tooDeep) return ARGUMENTS_TOO_DEEP;

  const bound = evaluationBounds.get(validate) ?? MAX_EVAL_PATHS;
  if (bound * measured.nodes > MAX_EVAL_WORK) return ARGUMENTS_TOO_LARGE;

  let passed: boolean;
  try {
    passed = validate(args) === true;
  } catch (error) {
    if (error instanceof RangeError) {
      return {
        ok: false,
        path: "arguments",
        expected: "bounded nesting depth",
        received: "deeper nesting",
        message: "arguments are nested too deeply.",
      };
    }
    return {
      ok: false,
      path: "arguments",
      expected: "bounded nesting depth",
      received: receivedType(args),
      message: "arguments could not be validated.",
    };
  }
  if (passed) return { ok: true };

  const first = (validate.errors ?? [])[0];
  if (first === undefined) {
    return {
      ok: false,
      path: "arguments",
      expected: "valid arguments",
      received: receivedType(args),
      message: "arguments did not match the tool's schema.",
    };
  }
  return describeAjvError(first, args, "arguments");
}
