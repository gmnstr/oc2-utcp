/**
 * Plugin configuration validation (spec §9 step 1).
 *
 * Validation fails closed: when the configuration is invalid the adapter
 * registers no tools at all. The reason is exposed through `status().error`
 * and the lifecycle log, not from individual tool calls.
 * Nothing here touches the network or the filesystem.
 */

import type { CallTemplate } from "@utcp/sdk";
import { displayText, failure, isObject, type FailureResult } from "./errors.js";
import {
  CONFIGURABLE_TRANSPORTS,
  DEFAULT_TRANSPORTS,
  normalizeCallTemplateType,
  type TransportClass,
} from "./transport.js";

/** Bounds of the per-manual `waitMs` option, in milliseconds (inclusive). */
export const WAIT_MS_MIN = 1_000;
export const WAIT_MS_MAX = 600_000;

export interface AdapterConfig {
  /** Root used to resolve relative manual paths; never the ambient cwd. */
  rootDir: string;
  /** Manual call templates, in configuration order. */
  manuals: CallTemplate[];
  /** Effective transport enablement. */
  transports: Record<TransportClass, boolean>;
  /** Tool-name allow patterns applied to the resolved SDK tool name. */
  toolPatterns: string[];
}

export type ConfigResult = { ok: true; config: AdapterConfig } | FailureResult;

const CONFIG_KEYS = new Set(["rootDir", "manuals", "transports", "tools"]);

function configInvalid(message: string): FailureResult {
  return failure({ code: "CONFIG_INVALID", message });
}

/**
 * Validates the plugin `options` object.
 *
 * Shape:
 *   {
 *     rootDir?: string,                  // defaults to ctx.location.directory
 *     manuals: CallTemplate[],           // required; may be empty
 *     transports?: { [class]: boolean }, // overrides the safe defaults
 *     tools?: string[]                   // allow patterns, default ["*"]
 *   }
 */
export function loadConfig(rawOptions: unknown, locationDirectory: string | undefined): ConfigResult {
  if (rawOptions === undefined || rawOptions === null) {
    return configInvalid(
      "Missing plugin options. Provide at least `manuals` (an array of UTCP manual call templates).",
    );
  }
  if (!isObject(rawOptions)) {
    return configInvalid("Plugin options must be an object.");
  }

  for (const key of Object.keys(rawOptions)) {
    if (!CONFIG_KEYS.has(key)) {
      return configInvalid(
        `Unknown plugin option '${displayText(key, 60)}'. Supported options: rootDir, manuals, transports, tools.`,
      );
    }
  }

  const rootDirRaw = rawOptions.rootDir;
  if (rootDirRaw !== undefined && (typeof rootDirRaw !== "string" || rootDirRaw.trim().length === 0)) {
    return configInvalid("`rootDir` must be a non-empty string when provided.");
  }
  const explicitRoot = (rootDirRaw as string | undefined)?.trim();
  // Spec §4: use the plugin's configured location, never the process working
  // directory — the host process cwd is not necessarily the session's project.
  // `rootDir` resolves relative manual paths, so guessing it would point the
  // SDK at an unrelated tree; fail closed instead.
  const rootDir = explicitRoot || locationDirectory?.trim() || "";
  if (rootDir.length === 0) {
    return configInvalid(
      "Cannot resolve the plugin location. Provide `rootDir`, or load the plugin from a configured project directory.",
    );
  }

  const manualsRaw = rawOptions.manuals;
  if (!Array.isArray(manualsRaw)) {
    return configInvalid("`manuals` must be an array of UTCP manual call templates.");
  }
  const manuals: CallTemplate[] = [];
  const seenNames = new Set<string>();
  for (let index = 0; index < manualsRaw.length; index += 1) {
    const candidate = manualsRaw[index];
    if (!isObject(candidate)) {
      return configInvalid(`\`manuals[${index}]\` must be an object.`);
    }
    // A missing or unknown `call_template_type` is not a configuration error:
    // §7.3 classifies it `unclassified`, which is disabled and never
    // registered. Rejecting it here would let one unnamed manual take down
    // every valid manual in the same configuration.
    if (candidate.name !== undefined) {
      if (typeof candidate.name !== "string" || candidate.name.trim().length === 0) {
        return configInvalid(`\`manuals[${index}].name\` must be a non-empty string when provided.`);
      }
      const sanitized = candidate.name.trim().replace(/[^\w]/g, "_");
      if (seenNames.has(sanitized)) {
        return configInvalid(
          `Duplicate manual name '${displayText(sanitized, 80)}'. Manual names must be unique after sanitization.`,
        );
      }
      seenNames.add(sanitized);
    }
    if (candidate.waitMs !== undefined) {
      const waitError = checkWaitMs(candidate, index);
      if (waitError !== null) return configInvalid(waitError);
    }
    manuals.push(candidate as unknown as CallTemplate);
  }

  const transports: Record<TransportClass, boolean> = { ...DEFAULT_TRANSPORTS };
  const transportsRaw = rawOptions.transports;
  if (transportsRaw !== undefined) {
    if (!isObject(transportsRaw)) {
      return configInvalid("`transports` must be an object mapping transport class to boolean.");
    }
    for (const [key, value] of Object.entries(transportsRaw)) {
      if (!(CONFIGURABLE_TRANSPORTS as readonly string[]).includes(key)) {
        return configInvalid(
          `Unknown transport class '${displayText(key, 60)}'. Configurable classes: ${CONFIGURABLE_TRANSPORTS.join(", ")}. ` +
            "`unclassified` cannot be enabled.",
        );
      }
      if (typeof value !== "boolean") {
        return configInvalid(`\`transports.${displayText(key, 60)}\` must be a boolean.`);
      }
      transports[key as TransportClass] = value;
    }
  }
  // `unclassified` can never be enabled, whatever a caller does to the object.
  transports.unclassified = false;

  let toolPatterns: string[] = ["*"];
  const toolsRaw = rawOptions.tools;
  if (toolsRaw !== undefined) {
    if (!Array.isArray(toolsRaw) || toolsRaw.length === 0) {
      return configInvalid("`tools` must be a non-empty array of tool-name patterns.");
    }
    for (let index = 0; index < toolsRaw.length; index += 1) {
      if (typeof toolsRaw[index] !== "string" || toolsRaw[index].trim().length === 0) {
        return configInvalid(`\`tools[${index}]\` must be a non-empty string.`);
      }
    }
    toolPatterns = toolsRaw.map((pattern: string) => pattern.trim());
  }

  return { ok: true, config: { rootDir, manuals, transports, toolPatterns } };
}

/**
 * Validates a manual's `waitMs`: only `http` and `sse` templates may carry it,
 * and the value must be an integer within WAIT_MS_MIN..WAIT_MS_MAX. The value
 * is not echoed; the message names the manual and the key.
 */
function checkWaitMs(candidate: Record<string, unknown>, index: number): string | null {
  const rawName = typeof candidate.name === "string" ? candidate.name.trim() : "";
  const label = rawName.length > 0 ? `manual '${displayText(rawName.replace(/[^\w]/g, "_"), 80)}'` : `manuals[${index}]`;
  const type = normalizeCallTemplateType(candidate.call_template_type);
  if (type !== "http" && type !== "sse") {
    return `\`waitMs\` on ${label} is supported only on \`http\` and \`sse\` call templates. Remove \`waitMs\` or change the manual's call template type.`;
  }
  const value = candidate.waitMs;
  if (typeof value !== "number" || !Number.isInteger(value) || value < WAIT_MS_MIN || value > WAIT_MS_MAX) {
    return `\`waitMs\` on ${label} must be an integer number of milliseconds from ${WAIT_MS_MIN} to ${WAIT_MS_MAX}.`;
  }
  return null;
}

/** Compiles an allow pattern with `*` (any run, including `.`) and `?` (one char). */
export function compileToolPattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

export function matchesAnyPattern(name: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(name));
}
