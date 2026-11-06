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
 *    schema before Ajv sees it: a node budget, a literal nesting limit, a
 *    `$ref` chain limit, and a static evaluation bound that rejects fan-out
 *    through shared definitions (see `evaluationBound`).
 * 2. Ajv compilation with coercion, defaults and removal all disabled, so the
 *    arguments that reach the transport are exactly the arguments supplied.
 *
 * Local references are supported: `$ref` only to `#/$defs/<name>` or
 * `#/definitions/<name>` in the root schema. Every other reference form, and
 * every keyword outside the table below, is rejected by name. A schema outside
 * the subset stays discoverable and describable but is never executable.
 */

import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import type { JsonSchema } from "@utcp/sdk";
import { displayText, type SchemaIssue } from "./errors.js";

/** Schema objects the walk may visit before the schema is refused as too large. */
export const MAX_SCHEMA_NODES = 10_000;
/**
 * Upper bound on validation paths a schema may generate. The bound multiplies
 * across `anyOf`/`oneOf` branches that re-enter a shared definition, so a
 * schema of n such levels costs about 2^n checks; it is refused above this.
 */
export const MAX_EVAL_PATHS = 16_384;
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
  // Numeric and array constraints (Tier B).
  "uniqueItems",
  "multipleOf",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "patternProperties",
]);

/**
 * Keywords explicitly rejected, with the keyword itself as the reported name.
 * Anything in neither set is also rejected: the walk fails closed.
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
}

export type ArgumentValidation =
  | { ok: true }
  | { ok: false; path: string; expected: string; received: string; message: string };

export interface CompiledSchema {
  check: SchemaCheck;
  validate?: ValidateFunction;
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
      case "patternProperties": {
        if (!isRecord(value)) {
          pushIssue(ctx.issues, childPath, "patternProperties");
          break;
        }
        for (const [pattern, subSchema] of Object.entries(value)) {
          const subPath = schemaPath(childPath, pattern);
          try {
            // Ajv compiles `pattern` keywords with the unicode flag, so a key
            // that only compiles without it would still fail later.
            new RegExp(pattern, "u");
          } catch {
            pushIssue(ctx.issues, subPath, "patternProperties");
            continue;
          }
          walk(subSchema, subPath, depth + 1, ctx);
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
          new RegExp(value);
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
      case "uniqueItems": {
        if (typeof value !== "boolean") pushIssue(ctx.issues, childPath, keyword);
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

/**
 * Result of visiting a schema node or reference target.
 * - `bound`: validation paths for one instance, saturated at BOUND_CAP.
 * - `hits`: back-edges (targets already in progress) reachable from this node
 *   through same-instance edges only, saturated at HIT_CAP. Above 1 means one
 *   instance is re-checked by several recursive branches.
 */
interface Visit {
  readonly bound: number;
  readonly hits: number;
}

/** Saturation point for `hits`: only "none", "one" and "more than one" matter. */
const HIT_CAP = 2;

/** Visits allowed per check. Hit-dependent results are not memoized, so this caps the work. */
const MAX_BOUND_VISITS = 4 * MAX_SCHEMA_NODES;

function addHits(a: number, b: number): number {
  return Math.min(HIT_CAP, a + b);
}

interface BoundState {
  readonly root: Record<string, unknown>;
  /** Finished result per reference target, keyed `<container>/<name>`. Only hit-free results are stored. */
  readonly memo: Map<string, Visit>;
  /** Targets on the current resolution path. Its size is the ref depth. */
  readonly inProgress: Set<string>;
  /** Nodes visited so far in this check. */
  visits: number;
  /** Back-edges to in-progress targets seen so far, including through descents. */
  backEdges: number;
}

const NO_CHAIN: ReadonlySet<string> = new Set();

function visitNode(
  node: Record<string, unknown>,
  path: string,
  chain: ReadonlySet<string>,
  state: BoundState,
): Visit {
  state.visits += 1;
  if (state.visits > MAX_BOUND_VISITS) halt("arguments", "$ref", "schema too large");

  if (hasOwn(node, "$ref") && typeof node["$ref"] === "string") {
    return visitRef(node["$ref"], schemaPath(path, "$ref"), chain, state);
  }

  // A descent (properties, items, additionalProperties, patternProperties)
  // makes the data smaller, so recursion through it ends with the data. A
  // same-instance edge (anyOf, oneOf) does not: the same data is validated
  // again by each branch. `chain` holds the targets entered since the last
  // descent on this path, which is what separates the two kinds of cycle.
  //
  // A back-edge hit under a descent is one level of data-driven recursion and
  // counts once. Several hits on one instance (two branches each recursing into
  // the same child) are the exponential case, so a descent child with more than
  // one hit is refused. Its hits are not passed upward, because the child's
  // data is a different instance from this node's.
  let bound = 1;
  let hits = 0;
  const descend = (child: unknown, childPath: string): void => {
    if (!isRecord(child)) return;
    const result = visitNode(child, childPath, NO_CHAIN, state);
    if (result.hits > 1) halt(childPath, "$ref", "recursion branches on the same instance");
    bound = addBound(bound, result.bound);
  };
  const sameInstance = (child: unknown, childPath: string): void => {
    if (!isRecord(child)) return;
    const result = visitNode(child, childPath, chain, state);
    bound = addBound(bound, result.bound);
    hits = addHits(hits, result.hits);
  };

  if (isRecord(node["properties"])) {
    for (const [name, sub] of Object.entries(node["properties"])) {
      descend(sub, schemaPath(schemaPath(path, "properties"), name));
    }
  }
  if (isRecord(node["items"])) descend(node["items"], schemaPath(path, "items"));
  if (isRecord(node["additionalProperties"])) {
    descend(node["additionalProperties"], schemaPath(path, "additionalProperties"));
  }
  if (isRecord(node["patternProperties"])) {
    for (const [pattern, sub] of Object.entries(node["patternProperties"])) {
      descend(sub, schemaPath(schemaPath(path, "patternProperties"), pattern));
    }
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = node[key];
    if (!Array.isArray(branches)) continue;
    branches.forEach((branch, index) => sameInstance(branch, schemaPath(schemaPath(path, key), String(index))));
  }
  return { bound, hits };
}

function visitRef(value: string, path: string, chain: ReadonlySet<string>, state: BoundState): Visit {
  const match = REF_PATTERN.exec(value);
  if (match === null) halt(path, "$ref", "reference is not a local definition");
  const container = match[1] ?? "";
  const name = match[2] ?? "";
  const key = `${container}/${name}`;

  // Entered again with no descent in between: the same data is checked by the
  // same schema forever. Ajv would not terminate, so the schema is refused.
  if (chain.has(key)) halt(path, "$ref", "reference cycle without descent");

  const finished = state.memo.get(key);
  if (finished !== undefined) return finished;

  // On the path, with a descent since it was entered: data-driven recursion.
  // Each level consumes one level of the data, so it counts once in bound, and
  // the hit records that this instance reached an ancestor again.
  if (state.inProgress.has(key)) {
    state.backEdges += 1;
    return { bound: 1, hits: 1 };
  }

  if (state.inProgress.size >= MAX_REF_DEPTH) halt(path, "$ref", "reference chain too deep");

  const members = state.root[container];
  const target = isRecord(members) ? members[name] : undefined;
  if (!isRecord(target)) halt(path, "$ref", "reference is not a local definition");

  state.inProgress.add(key);
  const backEdgesBefore = state.backEdges;
  const nextChain = new Set(chain);
  nextChain.add(key);
  let result: Visit;
  try {
    result = visitNode(target, `arguments.${container}.${name}`, nextChain, state);
  } finally {
    state.inProgress.delete(key);
  }
  // A result that reached an in-progress ancestor anywhere in its subtree (even
  // through a descent) depends on which ancestors are in progress, so it is
  // recomputed where it is reached again rather than reused.
  if (result.hits === 0 && state.backEdges === backEdgesBefore) state.memo.set(key, result);
  return result;
}

/**
 * Static bound on the validation work a walked schema can cause. A `$ref`
 * target whose result has no back-edge hits is evaluated once and memoized.
 * A result with hits is recomputed where it is reached, within MAX_BOUND_VISITS,
 * and a descent child that reaches the same in-progress target through two or
 * more same-instance branches is refused. The result counts the paths Ajv could take through the schema for one
 * instance: descents add, and so do the branches of `anyOf`/`oneOf` and the
 * targets of `$ref`, because all of those re-check the same instance.
 */
function evaluationBound(root: Record<string, unknown>): number {
  const state: BoundState = { root, memo: new Map(), inProgress: new Set(), visits: 0, backEdges: 0 };
  const { bound } = visitNode(root, "arguments", NO_CHAIN, state);
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
  try {
    walk(schema, "arguments", 0, ctx);
    if (ctx.issues.length === 0 && isRecord(schema)) {
      evaluationBound(schema);
    }
  } catch (error) {
    const issue = toIssue(error);
    ctx.issues.length = 0;
    ctx.issues.push(issue);
  }
  return { supported: ctx.issues.length === 0, issues: ctx.issues };
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
    const result: CompiledSchema = { check, validate };
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

/**
 * True when the arguments nest deeper than MAX_ARG_DEPTH containers, or hold
 * more than MAX_ARG_NODES values. Iterative: an explicit stack, so no input
 * depth can overflow the call stack.
 */
function argumentsTooDeep(value: unknown): boolean {
  const stack: Array<{ value: unknown; level: number }> = [{ value, level: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) break;
    visited += 1;
    if (visited > MAX_ARG_NODES) return true;

    const { value: current, level } = entry;
    let children: unknown[] | null = null;
    if (Array.isArray(current)) {
      children = current;
    } else if (isRecord(current)) {
      children = Object.values(current);
    }
    if (children === null) continue;
    if (level + 1 > MAX_ARG_DEPTH) return true;
    for (const child of children) stack.push({ value: child, level: level + 1 });
    if (visited + stack.length > MAX_ARG_NODES) return true;
  }
  return false;
}

const ARGUMENTS_TOO_DEEP: ArgumentValidation = {
  ok: false,
  path: "arguments",
  expected: "nesting depth of at most 64",
  received: "deeper nesting",
  message: "arguments are nested too deeply.",
};

/**
 * Validates arguments against a compiled schema. The object is validated
 * whole: no property is dropped, defaulted or coerced. Arguments nested beyond
 * MAX_ARG_DEPTH, or a validator that throws on them, fail without dispatch.
 */
export function validateArguments(validate: ValidateFunction, args: unknown): ArgumentValidation {
  if (argumentsTooDeep(args)) return ARGUMENTS_TOO_DEEP;

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
