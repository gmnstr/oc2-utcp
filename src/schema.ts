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
 *    rather than surfacing as an Ajv internal error.
 * 2. Ajv compilation with coercion, defaults and removal all disabled, so the
 *    arguments that reach the transport are exactly the arguments supplied.
 *
 * A schema outside the subset stays discoverable and describable but is never
 * executable.
 */

import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import type { JsonSchema } from "@utcp/sdk";
import { displayText, type SchemaIssue } from "./errors.js";

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
]);

/** Keywords explicitly rejected, with the keyword itself as the reported name. */
const REJECTED_KEYWORDS = new Set([
  "$ref",
  "$defs",
  "definitions",
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "patternProperties",
  "propertyNames",
  "dependencies",
  "dependentRequired",
  "dependentSchemas",
  "contains",
  "minContains",
  "maxContains",
  "prefixItems",
  "uniqueItems",
  "multipleOf",
  "exclusiveMinimum",
  "exclusiveMaximum",
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

/**
 * Dotted schema path, matching the spec's error example
 * (`arguments.properties.filter.oneOf`), not a JSON pointer.
 */
function schemaPath(base: string, key: string): string {
  return `${base}.${key}`;
}

function pushIssue(issues: SchemaIssue[], path: string, keyword: string): void {
  if (issues.length >= 8) return;
  issues.push({ path: path.length === 0 ? "arguments" : path, keyword });
}

function walk(schema: unknown, path: string, issues: SchemaIssue[]): void {
  if (issues.length >= 8) return;
  if (!isRecord(schema)) {
    // A boolean or otherwise non-object schema has no keyword to point at.
    pushIssue(issues, path, "<non-object schema>");
    return;
  }

  for (const [keyword, value] of Object.entries(schema)) {
    const childPath = schemaPath(path, keyword);

    if (REJECTED_KEYWORDS.has(keyword)) {
      pushIssue(issues, childPath, keyword);
      continue;
    }
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      // Fail closed: a keyword the adapter has no rule for is not silently ignored.
      pushIssue(issues, childPath, keyword);
      continue;
    }

    switch (keyword) {
      case "$schema": {
        if (typeof value !== "string" || !DRAFT_07_URIS.has(value)) {
          pushIssue(issues, childPath, "$schema");
        }
        break;
      }
      case "type": {
        const types = Array.isArray(value) ? value : [value];
        if (types.length === 0) {
          pushIssue(issues, childPath, "type");
          break;
        }
        for (const type of types) {
          if (typeof type !== "string" || !SUPPORTED_TYPES.has(type)) {
            pushIssue(issues, childPath, "type");
            break;
          }
        }
        break;
      }
      case "properties": {
        if (!isRecord(value)) {
          pushIssue(issues, childPath, "properties");
          break;
        }
        for (const [name, subSchema] of Object.entries(value)) {
          walk(subSchema, schemaPath(childPath, name), issues);
        }
        break;
      }
      case "items": {
        if (Array.isArray(value)) {
          // Tuple form is explicitly unsupported.
          pushIssue(issues, childPath, "items");
          break;
        }
        walk(value, childPath, issues);
        break;
      }
      case "additionalProperties": {
        if (typeof value !== "boolean") walk(value, childPath, issues);
        break;
      }
      case "required": {
        if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
          pushIssue(issues, childPath, "required");
        }
        break;
      }
      case "enum": {
        if (!Array.isArray(value) || value.length === 0) pushIssue(issues, childPath, "enum");
        break;
      }
      case "pattern": {
        if (typeof value !== "string") {
          pushIssue(issues, childPath, "pattern");
          break;
        }
        try {
          new RegExp(value);
        } catch {
          pushIssue(issues, childPath, "pattern");
        }
        break;
      }
      case "format": {
        if (typeof value !== "string" || !isKnownFormat(value)) {
          pushIssue(issues, childPath, "format");
        }
        break;
      }
      case "minimum":
      case "maximum":
      case "minLength":
      case "maxLength": {
        if (typeof value !== "number" || Number.isNaN(value)) pushIssue(issues, childPath, keyword);
        break;
      }
      case "title":
      case "description": {
        if (typeof value !== "string") pushIssue(issues, childPath, keyword);
        break;
      }
      case "examples": {
        if (!Array.isArray(value)) pushIssue(issues, childPath, "examples");
        break;
      }
      default:
        break;
    }
  }
}

/** Runs the explicit subset walk. Never throws. */
export function checkSchema(schema: unknown): SchemaCheck {
  const issues: SchemaIssue[] = [];
  walk(schema, "arguments", issues);
  return { supported: issues.length === 0, issues };
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
 * Validates arguments against a compiled schema. The object is validated
 * whole: no property is dropped, defaulted or coerced.
 */
export function validateArguments(validate: ValidateFunction, args: unknown): ArgumentValidation {
  if (validate(args) === true) return { ok: true };
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
